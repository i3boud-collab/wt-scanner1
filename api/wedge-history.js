// Development review of confirmed wedge setups; this is not a validated backtest.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(503).json({ error: 'History storage unavailable' });
  try {
    const response = await fetch(`${url}/get/wt_wedge_history`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error('History read failed');
    const body = await response.json();
    const records = body.result ? JSON.parse(body.result) : [];
    const limit = Math.min(300, Math.max(1, Number(req.query?.limit) || 100));
    res.status(200).json({ experimental: true, total: records.length, records: records.slice(0, limit) });
  } catch (error) {
    res.status(500).json({ error: 'History unavailable' });
  }
};
