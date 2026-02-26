// dev-server.js — للتطوير المحلي فقط
// شغّله بـ: node api/dev-server.js
const express = require("express");
const path    = require("path");
const scanFn  = require("./scan");
const sigFn   = require("./signals");

// محاكاة KV بـ in-memory
let _store = {};
global.KV_MOCK = {
  set: (k, v) => { _store[k] = v; },
  get: (k)    => _store[k] ?? null,
};

const app = express();
app.use(express.static(path.join(__dirname, "../public")));

// Mock KV env vars locally
process.env.KV_REST_API_URL   = process.env.KV_REST_API_URL   || "MOCK";
process.env.KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || "MOCK";

app.get("/api/scan",    (req, res) => scanFn(req, res));
app.get("/api/signals", (req, res) => sigFn(req, res));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Dev server → http://localhost:${PORT}`);
  console.log("   Triggering first scan...\n");
  // First scan on startup
  scanFn({ headers: {}, query: {} }, {
    status: () => ({ json: (d) => console.log("Scan result:", d.count, "signals") })
  }).catch(console.error);
});
