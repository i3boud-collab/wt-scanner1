// ─────────────────────────────────────────────────────────────
// config.js  —  عدّل هنا فقط
// ─────────────────────────────────────────────────────────────

const SYMBOLS = [
  // Mega-cap Tech
  "AAPL","MSFT","NVDA","META","GOOGL","AMZN","TSLA","AVGO",

  // Semiconductors
  "AMD","QCOM","INTC","MU","TXN","ASML","LRCX","AMAT",

  // Software / Cloud
  "CRM","ADBE","ORCL","NOW","SNOW","DDOG","CRWD","ZS","NET","PANW",

  // Consumer / E-comm
  "NFLX","SHOP","ABNB","PYPL","RBLX",

  // AI / Speculative
  "PLTR","AI","ARM","SMCI","MSTR",

  // Fintech / Crypto-adjacent
  "COIN","HOOD","SOFI",

  // Infrastructure
  "DELL","HPQ","CSCO",
];

const CONFIG = {
  INTERVAL:      "1h",          // 1h | 15m | 1d
  PERIOD:        "14d",         // lookback
  VOL_THRESHOLD: 500_000,       // حد الفوليوم العالي
  WT_N1:         10,
  WT_N2:         21,
  WT_NSC:        53,            // حد إشارة البيع
  WT_NSV:        -53,           // حد إشارة الشراء
  DAYS_BACK:     2,             // عرض إشارات آخر X أيام
  RSI_PERIOD:    14,
};

module.exports = { SYMBOLS, CONFIG };
