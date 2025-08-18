# Homebridge OPNsense Plus

Control OPNsense firewall rules from Apple HomeKit via Homebridge.  
Each configured OPNsense rule becomes a HomeKit **Switch**, with options to invert behavior.  
Optionally, expose **Gateway Status Sensors** that track WAN gateway health.

---

## Features

- 🔀 Multiple switches mapped to OPNsense rule UUIDs
- 🔁 Per-switch invert option (ON = disable rule)
- 🔐 TLS certificate verification with optional custom CA path
- 🛰 Optional Gateway sensors (occupancy/contact)
- 🧰 Advanced settings (timeouts, polling, status method)
- 📝 Structured logging and cache for performance

---

## Installation

```bash
sudo npm i -g homebridge-opnsense-plus
```

Restart Homebridge after install.

---

## Configuration

Add the platform to your `config.json`:

```json
{
  "platforms": [
    {
      "platform": "OPNsenseSwitches",
      "name": "OPNsense",
      "host": "firewall.example.com:8443",
      "apiKey": "APIKEY",
      "apiSecret": "APISECRET",
      "switches": [
        {
          "name": "Internet Access",
          "ruleUuid": "11111111-2222-3333-4444-555555555555",
          "invert": false
        }
      ],
      "Gateways": {
        "enabled": true,
        "pollInterval": 30,
        "sensorType": "occupancy",
        "include": ["WAN_DHCP", "STARLINK_DHCP6"]
      },
      "showAdvanced": true,
      "certificates": {
        "verifyTls": true,
        "caPath": "/etc/ssl/certs/custom-ca.pem"
      },
      "statusMethod": "getRule",
      "applyAfterToggle": false,
      "requestTimeout": 15000,
      "statusTtl": 3000,
      "pollInterval": 0
    }
  ]
}
```

### Switches
Each object in `switches` creates one HomeKit Switch.  
- `name` → Display name in HomeKit  
- `ruleUuid` → OPNsense rule UUID  
- `invert` → Reverse ON/OFF behavior  

### Gateways
Exposes each configured OPNsense gateway as a read-only sensor.  
- `enabled` → Enable/disable gateway sensors  
- `pollInterval` → Polling frequency (sec)  
- `sensorType` → `occupancy` (default) or `contact`  
- `include` → Optional list of gateway names to expose  

### Advanced Settings
Only shown if `showAdvanced: true`.  
- `certificates.verifyTls` → Enforce TLS verification  
- `certificates.caPath` → Path to custom CA file  
- `statusMethod` → `"getRule"` (default) or `"searchRule"`  
- `applyAfterToggle` → Apply firewall changes after toggle  
- `requestTimeout` → HTTP timeout in ms  
- `statusTtl` → Cache TTL for status lookups (ms)  
- `pollInterval` → Poll switches (sec, 0 = off)  

---

## Finding Rule UUIDs

1. Log into OPNsense Web UI.  
2. Go to **Firewall → Rules**.  
3. Edit the rule you want.  
4. Copy the UUID from the advanced details or JSON export.  

---

## License

Apache-2.0
