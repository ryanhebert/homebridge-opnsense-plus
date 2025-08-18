const axios = require("axios");
const https = require("https");
const fs = require("fs");

let hap, UUIDGen;

const PLUGIN_NAME = "homebridge-opnsense-plus";
const PLATFORM_NAME = "OPNsenseSwitches";

module.exports = (homebridge) => {
  hap = homebridge.hap;
  UUIDGen = homebridge.hap.uuid;

  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, OPNsensePlatform, true);
};

class OPNsensePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config || {};

    // Shared settings
    this.host = this.config.host; // e.g. "host:port"
    this.apiKey = this.config.apiKey;
    this.apiSecret = this.config.apiSecret;

    // Advanced / certs (supports current "certificates" and legacy "certificate Settings")
    const certs =
      (this.config && typeof this.config.certificates === "object" && this.config.certificates) ||
      (this.config && typeof this.config["certificate Settings"] === "object" && this.config["certificate Settings"]) ||
      {};

    // Defaults: self-signed friendly unless explicitly set
    this.verifyTls = typeof certs.verifyTls === "boolean" ? certs.verifyTls : false;
    this.caPath = certs.caPath || null;

    // Advanced networking / perf
    this.applyAfterToggle = this.config.applyAfterToggle === true;
    this.statusMethod = this.config.statusMethod || "getRule"; // "getRule" | "searchRule"
    this.switches = Array.isArray(this.config.switches) ? this.config.switches : [];

    // New tunables
    this.requestTimeout = Number(this.config.requestTimeout || 15000);
    this.statusTtl = Number(this.config.statusTtl || 3000); // ms
    this.pollInterval = Number(this.config.pollInterval || 0); // seconds (0 = off)

    // Accessory cache and state helpers
    this.accessories = new Map();   // UUID -> accessory (switches)
    this.gwAccessories = new Map(); // gwName -> accessory (gateways)
    this.stateCache = new Map();    // ruleUuid -> { ts, enabled }
    this.inFlightStatus = new Map(); // ruleUuid -> Promise<boolean>

    // Build one shared Axios client for the platform
    this.client = this.buildClient();

    // Gateway manager instance
    this.gwManager = null;

    api.on("didFinishLaunching", async () => {
      this.discoverAndRegister();

      if (this.pollInterval > 0) {
        this.pollTimer = setInterval(() => this.pollAll(), this.pollInterval * 1000);
      }

      // ---- BEGIN PATCH: support "Gateways" (capital G) and "gateways" in config ----
      const gatewaysCfg = (this.config.gateways || this.config.Gateways || {});
      if (gatewaysCfg && gatewaysCfg.enabled) {
        this.gwManager = new GatewaySensorManager({
          log: this.log,
          api: this.api,
          hap,
          client: this.client, // reuse shared axios + TLS
          namePrefix: this.config.name || "OPNsense",
          gatewaysConfig: gatewaysCfg,
          registerAccessory: (acc) =>
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]),
          unregisterAccessory: (acc) =>
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]),
          getCachedAccessoryByUUID: (uuid) => {
            // look in gateway map first, then switch map
            for (const a of this.gwAccessories.values()) if (a.UUID === uuid) return a;
            return this.accessories.get(uuid);
          },
          cacheGatewayAccessory: (gwName, acc) => this.gwAccessories.set(gwName, acc),
          getGatewayAccessory: (gwName) => this.gwAccessories.get(gwName),
          deleteGatewayAccessory: (gwName) => this.gwAccessories.delete(gwName),
        });
        await this.gwManager.start();
      }
      // ---- END PATCH ----
    });

    api.on("shutdown", () => {
      if (this.pollTimer) clearInterval(this.pollTimer);
      if (this.gwManager) this.gwManager.stop();
    });
  }

  // Homebridge calls this to restore from cache on restart
  configureAccessory(accessory) {
    this.log.debug("Restoring cached accessory:", accessory.displayName);
    accessory.context = accessory.context || {};

    // Route cached gateway sensors into gwAccessories (keep switches in accessories)
    if (accessory.context.kind === "gateway") {
      const gwName =
        accessory.context.gwName ||
        accessory.displayName.replace(/^.*GW:\s*/i, "") ||
        accessory.UUID;
      this.gwAccessories.set(gwName, accessory);
      return;
    }

    this.accessories.set(accessory.UUID, accessory);
  }

  async discoverAndRegister() {
    if (!this.host || !this.apiKey || !this.apiSecret) {
      this.log.error("[OPNsense] Missing host/apiKey/apiSecret in platform config — skipping.");
      return;
    }

    for (const sw of this.switches) {
      const name = sw.name || "OPNsense Rule";
      const ruleUuid = sw.ruleUuid;
      const invert = sw.invert !== undefined ? sw.invert : false;

      if (!ruleUuid) {
        this.log.warn(`Skipping switch "${name}" — missing ruleUuid`);
        continue;
      }

      // New stable UUID per switch (host + ruleUuid), so renames don't create duplicates
      const idSeedNew = `${this.host}::${ruleUuid}`;
      const idSeedOld = `${this.host}::${ruleUuid}::${name}`; // support migration from older seed
      const uuidNew = UUIDGen.generate(idSeedNew);
      const uuidOld = UUIDGen.generate(idSeedOld);

      let accessory = this.accessories.get(uuidNew) || this.accessories.get(uuidOld);

      if (accessory) {
        // Update existing cached accessory
        accessory.displayName = name;
        accessory.context.ruleUuid = ruleUuid;
        accessory.context.invert = invert;
        accessory.context.host = this.host;
        accessory.context.statusMethod = this.statusMethod;
        accessory.context.applyAfterToggle = this.applyAfterToggle;
        accessory.context.client = this.client; // shared client
        accessory.context.kind = "switch";
        this.setupServices(accessory);

        // If we found the old UUID, migrate to the new UUID seed by re-registering
        if (accessory.UUID === uuidOld && uuidNew !== uuidOld) {
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          const migrated = new this.api.platformAccessory(name, uuidNew);
          migrated.context = accessory.context;
          this.setupServices(migrated);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [migrated]);
          this.accessories.delete(uuidOld);
          this.accessories.set(uuidNew, migrated);
          this.log.info(`Migrated accessory UUID for: ${name}`);
        } else {
          this.api.updatePlatformAccessories([accessory]);
          this.accessories.set(uuidNew, accessory);
          this.log.info(`Updated accessory from cache: ${name}`);
        }
      } else {
        // Create new accessory
        accessory = new this.api.platformAccessory(name, uuidNew);
        accessory.context.ruleUuid = ruleUuid;
        accessory.context.invert = invert;
        accessory.context.host = this.host;
        accessory.context.statusMethod = this.statusMethod;
        accessory.context.applyAfterToggle = this.applyAfterToggle;
        accessory.context.client = this.client; // shared client
        accessory.context.kind = "switch";

        this.setupServices(accessory);

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuidNew, accessory);
        this.log.info(`Registered new accessory: ${name}`);
      }
    }

    // Remove accessories that no longer exist in config (match on host+ruleUuid only)
    const configuredIds = new Set(
      this.switches
        .filter(sw => sw.ruleUuid)
        .map(sw => UUIDGen.generate(`${this.host}::${sw.ruleUuid}`))
    );

    for (const [uuid, acc] of Array.from(this.accessories.entries())) {
      if (!configuredIds.has(uuid)) {
        this.log.info(`Unregistering accessory not present in config: ${acc.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.accessories.delete(uuid);
      }
    }
  }

  setupServices(accessory) {
    // Accessory Information
    const info = accessory.getService(hap.Service.AccessoryInformation);
    const pkg = this.safeRequirePackage();
    info
      ?.setCharacteristic(hap.Characteristic.Manufacturer, "OPNsense")
      .setCharacteristic(hap.Characteristic.Model, "Firewall Rule Switch")
      .setCharacteristic(hap.Characteristic.SerialNumber, accessory.context.ruleUuid);
    if (pkg?.version) {
      info?.setCharacteristic(hap.Characteristic.FirmwareRevision, pkg.version);
    }

    // Switch service
    let service = accessory.getService(hap.Service.Switch);
    if (!service) {
      service = accessory.addService(hap.Service.Switch, accessory.displayName);
    }

    // Wire up handlers
    service.getCharacteristic(hap.Characteristic.On)
      .onGet(() => this.handleGetOn(accessory))
      .onSet((value) => this.handleSetOn(accessory, value));
  }

  buildClient() {
    const httpsOpts = { rejectUnauthorized: this.verifyTls };
    if (this.caPath) {
      try {
        httpsOpts.ca = fs.readFileSync(this.caPath);
      } catch (e) {
        this.log.warn(`Failed to read CA at ${this.caPath}: ${e.message}`);
      }
    }
    return axios.create({
      baseURL: `https://${this.host}`,
      httpsAgent: new https.Agent(httpsOpts),
      auth: { username: this.apiKey, password: this.apiSecret },
      timeout: this.requestTimeout,
      validateStatus: (s) => s >= 200 && s < 500,
    });
  }

  // ------------ Handlers ------------

  async handleGetOn(accessory) {
    const ruleUuid = accessory.context.ruleUuid;
    const invert = accessory.context.invert;

    // Fast path: short TTL cache
    const cached = this.stateCache.get(ruleUuid);
    if (cached && (Date.now() - cached.ts) < this.statusTtl) {
      return invert ? !cached.enabled : cached.enabled;
    }

    try {
      const ruleEnabled = await this.fetchRuleEnabled(ruleUuid, accessory.context.statusMethod);
      this.stateCache.set(ruleUuid, { ts: Date.now(), enabled: ruleEnabled });
      return invert ? !ruleEnabled : ruleEnabled;
    } catch (err) {
      this.log.error(`[GET] ${accessory.displayName}: ${err.message}`);
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async handleSetOn(accessory, value) {
    const ruleUuid = accessory.context.ruleUuid;
    const invert = accessory.context.invert;
    const applyAfterToggle = accessory.context.applyAfterToggle;

    const svc = accessory.getService(hap.Service.Switch);
    const currentHomeOn = svc.getCharacteristic(hap.Characteristic.On).value;

    try {
      const targetRuleEnabled = invert ? !value : value; // desired firewall rule state
      const currentEnabled = await this.fetchRuleEnabled(ruleUuid, accessory.context.statusMethod);

      if (currentEnabled === targetRuleEnabled) {
        this.log.debug(`[SET] ${accessory.displayName}: no change needed`);
        return;
      }

      // Optimistic update for snappier UX
      svc.updateCharacteristic(hap.Characteristic.On, value);

      await this.withRetry(() => this.toggleRule(ruleUuid));
      if (applyAfterToggle) {
        await this.withRetry(() => this.applyChanges());
      }

      // Update cache to reflect new state
      this.stateCache.set(ruleUuid, { ts: Date.now(), enabled: targetRuleEnabled });
      this.log.info(`[SET] ${accessory.displayName}: rule enabled=${targetRuleEnabled}`);
    } catch (err) {
      // Revert optimistic update on failure
      try { svc.updateCharacteristic(hap.Characteristic.On, currentHomeOn); } catch (_) {}
      this.log.error(`[SET] ${accessory.displayName}: ${err.message}`);
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // ------------ OPNsense helpers ------------

  async fetchRuleEnabled(ruleUuid, statusMethod) {
    // Merge concurrent in-flight requests for the same rule
    if (this.inFlightStatus.has(ruleUuid)) {
      return this.inFlightStatus.get(ruleUuid);
    }

    const p = (async () => {
      if (statusMethod === "getRule") {
        try {
          const res = await this.withRetry(() => this.client.get(`/api/firewall/filter/getRule/${ruleUuid}`));
          if (res.status >= 400) throw new Error(this.describeHttp(res));
          const enabled = res?.data?.rule?.enabled;
          if (enabled === "1" || enabled === 1 || enabled === true) return true;
          if (enabled === "0" || enabled === 0 || enabled === false) return false;
          if (typeof enabled === "undefined") return false; // treat missing as disabled
          throw new Error("Could not parse rule.enabled");
        } catch (e) {
          // fallback to searchRule
          this.log.warn(`getRule failed; falling back to searchRule: ${e.message}`);
        }
      }

      const res = await this.withRetry(() => this.client.post(`/api/firewall/filter/searchRule`, {
        current: 1,
        rowCount: -1,
        sort: {},
        searchPhrase: ruleUuid,
      }));
      if (res.status >= 400) throw new Error(this.describeHttp(res));
      const rows = res?.data?.rows || [];
      const match = rows.find(r => r?.uuid === ruleUuid);
      if (!match) throw new Error("Rule UUID not found in search results");
      const enabled = match.enabled;
      return enabled === "1" || enabled === 1 || enabled === true;
    })()
      .finally(() => this.inFlightStatus.delete(ruleUuid));

    this.inFlightStatus.set(ruleUuid, p);
    return p;
  }

  async toggleRule(ruleUuid) {
    const res = await this.client.post(`/api/firewall/filter/toggleRule/${ruleUuid}`);
    if (res.status >= 400) throw new Error(this.describeHttp(res));
    return res.data;
  }

  async applyChanges() {
    const res = await this.client.post(`/api/firewall/filter/apply`, {});
    if (res.status >= 400) throw new Error(this.describeHttp(res));
    return res.data;
  }

  // ------------ Utilities ------------

  async withRetry(fn, tries = 3) {
    let attempt = 0, delay = 250;
    for (;;) {
      try { return await fn(); }
      catch (e) {
        attempt++;
        const retriable = !e.response || e.response.status >= 500 || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT';
        if (!retriable || attempt >= tries) throw e;
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
      }
    }
  }

  describeHttp(res) {
    const status = res?.status ?? "";
    const msg = res?.statusText || "";
    return `HTTP ${status} ${msg}`;
  }

  safeRequirePackage() {
    try {
      // Resolve relative to plugin root
      const pkgPath = require.resolve('./package.json', { paths: [__dirname] });
      return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch {
      return null;
    }
  }

  async pollAll() {
    for (const acc of this.accessories.values()) {
      const ruleUuid = acc.context.ruleUuid;
      try {
        const enabled = await this.fetchRuleEnabled(ruleUuid, acc.context.statusMethod);
        this.stateCache.set(ruleUuid, { ts: Date.now(), enabled });
        const homeOn = acc.context.invert ? !enabled : enabled;
        acc.getService(hap.Service.Switch)?.updateCharacteristic(hap.Characteristic.On, homeOn);
      } catch (e) {
        this.log.debug(`[POLL] ${acc.displayName}: ${e.message}`);
        // Intentionally do not update characteristic to avoid flapping
      }
    }
  }
}


/* ------------------------------- */
/* GatewaySensorManager (read-only)*/
/* ------------------------------- */

class GatewaySensorManager {
  constructor(opts) {
    this.log = opts.log;
    this.api = opts.api;
    this.hap = opts.hap;
    this.client = opts.client; // axios with TLS + auth set up
    this.namePrefix = opts.namePrefix || "OPNsense";

    // config.gateways fields
    const gw = opts.gatewaysConfig || {};
    this.enabled = !!gw.enabled;
    this.pollInterval = Math.max(5, Number(gw.pollInterval || 30));
    this.sensorType = (gw.sensorType === "contact") ? "contact" : "occupancy"; // default occupancy
    this.include = Array.isArray(gw.include) ? new Set(gw.include) : null;

    // registry helpers wired from platform
    this.registerAccessory = opts.registerAccessory;
    this.unregisterAccessory = opts.unregisterAccessory;
    this.getCachedAccessoryByUUID = opts.getCachedAccessoryByUUID;
    this.cacheGatewayAccessory = opts.cacheGatewayAccessory;
    this.getGatewayAccessory = opts.getGatewayAccessory;
    this.deleteGatewayAccessory = opts.deleteGatewayAccessory;

    this.timer = null;
  }

  async start() {
    if (!this.enabled) {
      this.log.info("[opnsense] Gateway sensors disabled.");
      return;
    }
    await this.refreshOnce();
    this.timer = setInterval(() => this.refreshOnce(), this.pollInterval * 1000);
    this.log.info(`[opnsense] Gateway sensors started; polling every ${this.pollInterval}s`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refreshOnce() {
    try {
      const gateways = await this.fetchGateways();
      const seen = new Set();

      for (const gw of gateways) {
        const name = this.extractName(gw);
        if (!name) continue;
        if (this.include && !this.include.has(name)) continue;

        seen.add(name);
        const online = this.isOnline(gw);
        this.upsertSensor(name, online, gw);
      }

      // prune accessories that disappeared
      for (const [gwName, acc] of Array.from(this._gwEntries())) {
        if (!seen.has(gwName)) {
          this.unregisterAccessory(acc);
          this.deleteGatewayAccessory(gwName);
          this.log.info(`[opnsense] Removed gateway sensor for ${gwName}`);
        }
      }
    } catch (e) {
      this.log.error("[opnsense] Gateway refresh failed:", e?.message || e);
      // mark as faulted if any currently registered
      for (const [, acc] of this._gwEntries()) {
        const svc = this._getService(acc);
        svc?.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.GENERAL_FAULT);
      }
    }
  }

  *_gwEntries() {
    // helper to iterate name->accessory from platform map
    const map = new Map();
    const listHolder = (this.api._opnsenseGwList = this.api._opnsenseGwList || []);
    for (const name of listHolder) {
      const acc = this.getGatewayAccessory(name);
      if (acc) map.set(name, acc);
    }
    yield* map.entries();
  }

  _rememberGw(name) {
    const listHolder = (this.api._opnsenseGwList = this.api._opnsenseGwList || []);
    if (!listHolder.includes(name)) listHolder.push(name);
  }

  _forgetGw(name) {
    const listHolder = (this.api._opnsenseGwList = this.api._opnsenseGwList || []);
    const idx = listHolder.indexOf(name);
    if (idx >= 0) listHolder.splice(idx, 1);
  }

  async fetchGateways() {
    // Primary: /api/routes/gateway/status
    const r1 = await this.client.get(`/api/routes/gateway/status`);
    if (r1.status >= 200 && r1.status < 300 && r1.data) {
      // Handle shapes:
      // { items: [...] , status: "ok" }
      // { rows: [...] } / { data: [...] } / { gateways: [...] }
      const rows = Array.isArray(r1.data)
        ? r1.data
        : (r1.data.items || r1.data.rows || r1.data.data || r1.data.gateways || []);
      if (rows && rows.length) return rows;
    }

    // Fallback: /api/routing/settings/searchGateway (config view; may lack live metrics)
    const r2 = await this.client.get(`/api/routing/settings/searchGateway`);
    if (r2.status >= 200 && r2.status < 300 && r2.data) {
      const rows = Array.isArray(r2.data) ? r2.data : (r2.data.rows || r2.data.data || []);
      return rows || [];
    }

    throw new Error(`Unexpected gateway response`);
  }


  extractName(gw) {
    return gw.name || gw.gateway || gw.devname || gw.tag || gw.description || null;
  }

  isOnline(gw) {
    // Normalize status fields to string
    const s = String(gw.status || "").toLowerCase().trim();
    const t = String(gw.status_translated || "").toLowerCase().trim();

    // OPNsense patterns seen:
    // - status: "none" (OK), "down"
    // - status_translated: "Online", "Offline"
    if (t === "online") return true;
    if (t === "offline") return false;

    if (s === "none" || s === "up") return true;
    if (s === "down" || s === "alarm" || s === "unreachable") return false;

    // Heuristic on packet loss if present ("0.0 %", "~")
    const lossRaw = (gw.loss ?? "").toString().replace("%", "").replace("~", "").trim();
    const lossNum = Number(lossRaw);
    if (!Number.isNaN(lossNum)) {
      return lossNum === 0;
    }

    // If ambiguous, default optimistic
    return true;
  }

  ensureServiceType(acc) {
    const wantContact = (this.sensorType === "contact");
    const occSvc = acc.getService(this.hap.Service.OccupancySensor);
    const conSvc = acc.getService(this.hap.Service.ContactSensor);

    // If we want Contact, remove Occupancy (if present) and ensure Contact exists
    if (wantContact) {
      if (occSvc) {
        acc.removeService(occSvc);
      }
      let svc = acc.getService(this.hap.Service.ContactSensor);
      if (!svc) {
        svc = acc.addService(this.hap.Service.ContactSensor, acc.displayName);
      }
      return svc;
    }

    // Else we want Occupancy, remove Contact (if present) and ensure Occupancy exists
    if (conSvc) {
      acc.removeService(conSvc);
    }
    let svc = acc.getService(this.hap.Service.OccupancySensor);
    if (!svc) {
      svc = acc.addService(this.hap.Service.OccupancySensor, acc.displayName);
    }
    return svc;
  }



  upsertSensor(gwName, online, raw) {
  const uuid = UUIDGen.generate(`opnsense-gateway-${gwName}`);
  let acc = this.getGatewayAccessory(gwName);

  if (!acc) {
    // try cache by UUID in case Homebridge restored it
    acc = this.getCachedAccessoryByUUID(uuid);
    if (!acc) {
      //const displayName = `${this.namePrefix} GW: ${gwName}`;
      const displayName = `${gwName}`;
      acc = new this.api.platformAccessory(displayName, uuid);
    }

    // mark and basic info
    acc.context.kind = "gateway";
    acc.context.gwName = gwName;

    // register and cache (service will be ensured below)
    if (!this.getCachedAccessoryByUUID(uuid)) {
      this.registerAccessory(acc);
    }
    this.cacheGatewayAccessory(gwName, acc);
    this._rememberGw(gwName);
    this.log.info(`[opnsense] Added gateway sensor for ${gwName}`);
  }

  // Ensure the correct service type exists (and remove the wrong one if needed)
  const svc = this.ensureServiceType(acc);

  // Update Accessory Information with IP/monitor
  const info = acc.getService(this.hap.Service.AccessoryInformation);
  const ipAddr = (raw.address && raw.address !== "~") ? String(raw.address) : null;
  const monitor = (raw.monitor && raw.monitor !== "~") ? String(raw.monitor) : null;

  info?.setCharacteristic(this.hap.Characteristic.Manufacturer, "OPNsense")
      ?.setCharacteristic(this.hap.Characteristic.Model, monitor
        ? `Gateway Sensor (MON: ${monitor})`
        : `Gateway Sensor`)
      ?.setCharacteristic(this.hap.Characteristic.SerialNumber, ipAddr || monitor || gwName);

  // Init / update common characteristics
  svc.setCharacteristic(this.hap.Characteristic.StatusActive, true);
  svc.updateCharacteristic(
    this.hap.Characteristic.StatusFault,
    online ? this.hap.Characteristic.StatusFault.NO_FAULT : this.hap.Characteristic.StatusFault.GENERAL_FAULT
  );

  // Update the primary state
  if (this.sensorType === "contact") {
    const CS = this.hap.Characteristic.ContactSensorState;
    svc.updateCharacteristic(CS, online ? CS.CONTACT_DETECTED : CS.CONTACT_NOT_DETECTED);
  } else {
    const OD = this.hap.Characteristic.OccupancyDetected;
    svc.updateCharacteristic(OD, online ? OD.OCCUPANCY_DETECTED : OD.OCCUPANCY_NOT_DETECTED);
  }

  // optional debug metrics
  if (typeof raw.delay !== "undefined" || typeof raw.rtt !== "undefined") {
    this.log.debug?.(
      `[opnsense] ${gwName} online=${online} delay=${raw.delay ?? raw.rtt ?? "n/a"} loss=${raw.loss ?? "n/a"}`
    );
  }
  }



  _getService(acc) {
    return (this.sensorType === "contact")
      ? acc.getService(this.hap.Service.ContactSensor)
      : acc.getService(this.hap.Service.OccupancySensor);
  }
}
