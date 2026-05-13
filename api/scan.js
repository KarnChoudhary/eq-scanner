// api/scan.js — Vercel serverless function (CommonJS)
// Uses stooq.com — free NSE daily OHLCV, no auth, no cookies
// GET /api/scan?symbol=RELIANCE
// Returns: { symbol, candles: [{date,open,high,low,close,volume},...] }

const https = require("https");

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "text/csv,text/plain,*/*",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// Parse stooq CSV → candle array
// CSV format: Date,Open,High,Low,Close,Volume
function parseCSV(csv) {
  const lines = csv.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  // skip header line
  const candles = [];
  for (let i = 1; i < lines.length; i++) {
    const [date, open, high, low, close, volume] = lines[i].split(",");
    if (!date || !close || close === "N/D") continue;
    candles.push({
      date,
      open:   parseFloat(open),
      high:   parseFloat(high),
      low:    parseFloat(low),
      close:  parseFloat(close),
      volume: parseInt(volume) || 0,
    });
  }
  // stooq returns newest first — reverse to chronological
  return candles.reverse();
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const raw = ((req.query && req.query.symbol) || "").trim().toUpperCase();
  if (!raw) return res.status(400).json({ error: "symbol param required" });

  // stooq expects lowercase .ns suffix  e.g. reliance.ns
  const stooqSym = raw.toLowerCase().replace(/\.ns$/, "") + ".ns";
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`;

  try {
    const { status, body } = await httpsGet(url);

    if (status !== 200) {
      return res.status(502).json({ error: `stooq returned HTTP ${status} for ${stooqSym}` });
    }

    // stooq returns "No data" page as HTML when symbol not found
    if (body.trim().startsWith("<") || body.includes("No data")) {
      return res.status(404).json({
        error: `Symbol "${raw}" not found on stooq. Try the exact NSE ticker (e.g. HDFCBANK, not HDFC BANK).`,
      });
    }

    const candles = parseCSV(body);

    if (candles.length < 60) {
      return res.status(422).json({
        error: `Only ${candles.length} candles for ${raw} — need 60+`,
      });
    }

    return res.status(200).json({ symbol: raw, candles });

  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal error" });
  }
};
