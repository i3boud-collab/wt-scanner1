// api/signals.js
async function kvGet(key) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${key}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  if (!j.result) return null;
  try { return JSON.parse(j.result); } catch { return j.result; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  try {
    const data = await kvGet("wt_signals");
    if (!data) return res.status(200).json({
      "15m": { signals: [] }, "1h": { signals: [] }, "4h": { signals: [] },
      updatedAt: null, symbolCount: 0, status: "initializing",
    });
    res.status(200).json({ ...data, status: "ok" });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
