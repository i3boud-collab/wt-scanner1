module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(503).json({ error: 'Signal history storage is unavailable' });
  try {
    const response = await fetch(`${url}/get/wt_signal_ledger`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Storage read failed (${response.status})`);
    const raw = (await response.json()).result;
    const ledger = raw ? JSON.parse(raw) : null;
    res.status(200).json({ records: Array.isArray(ledger?.records) ? ledger.records : [],
      updatedAt: ledger?.updatedAt || null, retentionDays: 120, limit: 1800 });
  } catch (error) {
    res.status(503).json({ error: 'Signal history is temporarily unavailable' });
  }
};
