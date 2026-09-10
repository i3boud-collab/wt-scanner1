// ─────────────────────────────────────────────────────────────
// config.js  —  عدّل هنا فقط
// ─────────────────────────────────────────────────────────────

const SYMBOLS = [
  "TSLA","NVDA","AAPL","META","GOOGL",
  "MSFT","AMD","NOW","MU","INTC",
  "QCOM","MRVL","ORCL","SPXC","AVGO",
  "UBER",
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
