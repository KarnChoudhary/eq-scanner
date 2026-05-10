// api/scan.js  — Vercel serverless function (CommonJS)
// GET /api/scan?symbol=RELIANCE
// Returns: { symbol, candles: [{date,open,high,low,close,volume}, ...] }

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const symbol = ((req.query && req.query.symbol) || "").toUpperCase().trim();
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });

  try {
    // Step 1: Get session cookie
    let cookie = "";
    try {
      const cookieRes = await fetch("https://finance.yahoo.com/", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
      });
      const raw = cookieRes.headers.get("set-cookie") || "";
      cookie = raw.split(";")[0];
    } catch (_) {}

    // Step 2: Get crumb
    let crumb = "";
    try {
      const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Cookie": cookie,
        },
      });
      if (crumbRes.ok) crumb = await crumbRes.text();
    } catch (_) {}

    // Step 3: Fetch chart — try query1 then query2 as fallback
    const buildUrl = (host) => {
      const base = `https://${host}.finance.yahoo.com/v8/chart/${symbol}.NS?interval=1d&range=1y`;
      return crumb ? `${base}&crumb=${encodeURIComponent(crumb)}` : base;
    };
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/json",
      "Cookie": cookie,
    };

    let data;
    for (const host of ["query1", "query2"]) {
      const r = await fetch(buildUrl(host), { headers });
      if (r.ok) { data = await r.json(); break; }
    }

    if (!data) return res.status(502).json({ error: `Yahoo Finance unavailable for ${symbol}` });

    const result = data?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: `No data for ${symbol}.NS` });

    const { timestamp, indicators: { quote: [q] } } = result;
    const candles = [];
    for (let i = 0; i < timestamp.length; i++) {
      if (q.close[i] == null || q.high[i] == null || q.low[i] == null) continue;
      candles.push({
        date:   new Date(timestamp[i] * 1000).toISOString().slice(0, 10),
        open:   Math.round(q.open[i]   * 100) / 100,
        high:   Math.round(q.high[i]   * 100) / 100,
        low:    Math.round(q.low[i]    * 100) / 100,
        close:  Math.round(q.close[i]  * 100) / 100,
        volume: q.volume[i] ?? 0,
      });
    }

    if (candles.length < 60)
      return res.status(422).json({ error: `Only ${candles.length} candles — need 60+` });

    return res.status(200).json({ symbol, candles });

  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal error" });
  }
};
