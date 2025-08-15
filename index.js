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

    // Defaults: self‑signed friendly unless explicitly set
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
    this.accessories = new Map(); // UUID -> accessory
    this.stateCache = new Map();   // ruleUuid -> { ts, enabled }
    this.inFlightStatus = new Map(); // ruleUuid -> Promise<boolean>

    // Build one shared Axios client for the platform
    this.client = this.buildClient();

    api.on("didFinishLaunching", () => {
      this.discoverAndRegister();
      if (this.pollInterval > 0) {
        this.pollTimer = setInterval(() => this.pollAll(), this.pollInterval * 1000);
      }
    });

    api.on("shutdown", () => {
      if (this.pollTimer) clearInterval(this.pollTimer);
    });
  }

  // Homebridge calls this to restore from cache on restart
  configureAccessory(accessory) {
    this.log.debug("Restoring cached accessory:", accessory.displayName);
    accessory.context = accessory.context || {};
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