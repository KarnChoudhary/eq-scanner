// api/scan.js — Vercel serverless function (CommonJS, Node.js)
// Calls Yahoo Finance directly — no Supabase proxy needed
// GET /api/scan?symbol=RELIANCE

const https = require("https");

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const req = https.request(
      {
        hostname: opts.hostname,
        path: opts.pathname + opts.search,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json, text/html, */*",
          "Accept-Language": "en-US,en;q=0.9",
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const raw = ((req.query && req.query.symbol) || "").toUpperCase().trim();
  if (!raw) return res.status(400).json({ error: "symbol query param required" });
  const symbol = raw.endsWith(".NS") ? raw : `${raw}.NS`;

  try {
    // ── Step 1: Get cookie ──
    let cookie = "";
    try {
      const r = await httpsGet("https://finance.yahoo.com/", {});
      const setCookie = r.headers["set-cookie"];
      if (setCookie) {
        const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
        cookie = arr.map(c => c.split(";")[0]).join("; ");
      }
    } catch (_) {}

    // ── Step 2: Get crumb ──
    let crumb = "";
    try {
      const r = await httpsGet(
        "https://query1.finance.yahoo.com/v1/test/getcrumb",
        { Cookie: cookie }
      );
      if (r.status === 200) crumb = r.body.trim();
    } catch (_) {}

    // ── Step 3: Fetch chart data ──
    const baseUrl = `https://query1.finance.yahoo.com/v8/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`;
    const chartUrl = crumb ? `${baseUrl}&crumb=${encodeURIComponent(crumb)}` : baseUrl;

    let chartData = null;
    for (const host of ["query1", "query2"]) {
      try {
        const r = await httpsGet(chartUrl.replace("query1", host), { Cookie: cookie });
        if (r.status === 200) {
          chartData = JSON.parse(r.body);
          break;
        }
      } catch (_) {}
    }

    if (!chartData) {
      return res.status(502).json({ error: `Could not fetch data for ${symbol} from Yahoo Finance` });
    }

    const result = chartData?.chart?.result?.[0];
    if (!result) {
      return res.status(404).json({ error: `No chart data found for ${symbol}` });
    }

    const { timestamp, indicators: { quote: [q] } } = result;
    const candles = [];
    for (let i = 0; i < timestamp.length; i++) {
      if (q.close[i] == null || q.high[i] == null || q.low[i] == null) continue;
      candles.push({
        date:   new Date(timestamp[i] * 1000).toISOString().slice(0, 10),
        open:   Math.round(q.open[i]  * 100) / 100,
        high:   Math.round(q.high[i]  * 100) / 100,
        low:    Math.round(q.low[i]   * 100) / 100,
        close:  Math.round(q.close[i] * 100) / 100,
        volume: q.volume[i] ?? 0,
      });
    }

    if (candles.length < 60) {
      return res.status(422).json({
        error: `Only ${candles.length} candles for ${symbol} — need 60+`,
      });
    }

    return res.status(200).json({ symbol: raw, candles });

  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal error" });
  }
};
