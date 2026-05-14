// api/scan.js — Vercel serverless function (CommonJS)
const https = require("https");

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/csv,text/plain,*/*",
      },
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

function parseCSV(csv) {
  const lines = csv.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const candles = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 5) continue;
    const [date, open, high, low, close, volume] = parts;
    if (!date || !close || close.trim() === "N/D" || isNaN(parseFloat(close))) continue;
    candles.push({
      date:   date.trim(),
      open:   parseFloat(open),
      high:   parseFloat(high),
      low:    parseFloat(low),
      close:  parseFloat(close),
      volume: parseInt(volume) || 0,
    });
  }
  return candles.reverse(); // stooq = newest first
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const raw = ((req.query && req.query.symbol) || "").trim().toUpperCase();
  if (!raw) return res.status(400).json({ error: "symbol param required" });

  const debug = req.query.debug === "1";
  const stooqSym = raw.toLowerCase().replace(/\.ns$/, "") + ".ns";
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`;

  try {
    const { status, headers, body } = await httpsGet(url);

    // Debug mode — return raw response so we can see what stooq returns
    if (debug) {
      return res.status(200).json({
        stooqUrl: url,
        httpStatus: status,
        contentType: headers["content-type"],
        bodyLength: body.length,
        first500: body.slice(0, 500),
      });
    }

    if (status !== 200) {
      return res.status(502).json({ error: `stooq returned HTTP ${status}`, stooqUrl: url });
    }

    if (body.trim().startsWith("<") || body.toLowerCase().includes("no data")) {
      return res.status(404).json({
        error: `Symbol "${raw}" not found on stooq`,
        hint: "Try exact NSE ticker e.g. HDFCBANK, RELIANCE, FEDFINA",
        stooqUrl: url,
      });
    }

    const candles = parseCSV(body);

    if (candles.length < 60) {
      return res.status(422).json({
        error: `Only ${candles.length} candles for ${raw}`,
        stooqUrl: url,
        rawPreview: body.slice(0, 300), // show raw so we can debug
      });
    }

    return res.status(200).json({ symbol: raw, candles });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
