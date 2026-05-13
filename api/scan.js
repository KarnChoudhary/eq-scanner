// api/scan.js — Vercel serverless function (CommonJS)
// Uses stooq.com for NSE daily OHLCV data
// GET /api/scan?symbol=RELIANCE
// GET /api/scan?symbol=RELIANCE&debug=1  ← shows raw stooq response

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
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/csv,text/plain,*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://stooq.com/",
        },
      },
      (res) => {
        // follow redirect manually if needed
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return httpsGet(res.headers.location).then(resolve).catch(reject);
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      }
    );
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// Parse stooq CSV → candle array
// stooq format: Date,Open,High,Low,Close,Volume  (newest first)
function parseCSV(csv) {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase();
  // confirm it's actually a CSV with expected columns
  if (!header.includes("date") || !header.includes("close")) return [];
  const candles = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 5) continue;
    const [date, open, high, low, close, volume] = parts;
    const c = parseFloat(close);
    if (!date || isNaN(c) || c <= 0) continue;
    candles.push({
      date:   date.trim(),
      open:   parseFloat(open)  || c,
      high:   parseFloat(high)  || c,
      low:    parseFloat(low)   || c,
      close:  c,
      volume: parseInt(volume)  || 0,
    });
  }
  // stooq returns newest first — reverse to oldest→newest
  return candles.reverse();
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const raw   = ((req.query && req.query.symbol) || "").trim().toUpperCase();
  const debug = req.query.debug === "1";
  if (!raw) return res.status(400).json({ error: "symbol param required" });

  // stooq NSE format: reliance.ns (lowercase, .ns suffix)
  const stooqSym = raw.toLowerCase().replace(/\.ns$/, "") + ".ns";

  // Try both stooq URL formats
  const urls = [
    `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`,
    `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d&d1=19000101`,
  ];

  try {
    let body = "", status = 0;

    for (const url of urls) {
      const r = await httpsGet(url);
      status = r.status;
      body = r.body;
      if (debug) {
        return res.status(200).json({
          url, status,
          first500chars: body.slice(0, 500),
          lineCount: body.split("\n").length,
        });
      }
      // Check if we got valid CSV
      if (status === 200 && body.trim().startsWith("Date")) break;
    }

    if (status !== 200) {
      return res.status(502).json({ error: `stooq returned HTTP ${status} for ${stooqSym}` });
    }

    if (!body.trim().startsWith("Date")) {
      return res.status(404).json({
        error: `No CSV data for "${raw}". Check the NSE ticker spelling.`,
        hint: `Expected "Date,Open,High,Low,Close,Volume" but got: ${body.slice(0, 100)}`,
      });
    }

    const candles = parseCSV(body);

    if (candles.length < 60) {
      return res.status(422).json({
        error: `Only ${candles.length} candles for ${raw} — need 60+`,
        hint: `Raw line count: ${body.split("\n").length}. First line: ${body.split("\n")[0]}`,
      });
    }

    return res.status(200).json({ symbol: raw, candles });

  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal error" });
  }
};
