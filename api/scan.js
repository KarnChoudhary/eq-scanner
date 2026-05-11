// api/scan.js — Vercel serverless function (CommonJS)
// Proxies through your existing Supabase yahoo-proxy edge function
// GET /api/scan?symbol=RELIANCE
// Returns: { symbol, candles: [{date,open,high,low,close,volume}, ...] }

const SUPABASE_URL  = "https://hehxbolrheumzpeharlm.supabase.co/functions/v1/yahoo-proxy";
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || "";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const raw = ((req.query && req.query.symbol) || "").toUpperCase().trim();
  if (!raw) return res.status(400).json({ error: "symbol query param required" });

  // Always append .NS for NSE stocks
  const symbol = raw.endsWith(".NS") ? raw : `${raw}.NS`;

  try {
    const proxyUrl = `${SUPABASE_URL}?symbol=${encodeURIComponent(symbol)}&action=quote&interval=1d&range=1y`;

    const headers = {
      "Content-Type": "application/json",
    };
    if (SUPABASE_ANON) {
      headers["Authorization"] = `Bearer ${SUPABASE_ANON}`;
    }

    const proxyRes = await fetch(proxyUrl, { headers });

    if (!proxyRes.ok) {
      const text = await proxyRes.text();
      return res.status(proxyRes.status).json({
        error: `Supabase proxy returned ${proxyRes.status}`,
        detail: text.slice(0, 200),
      });
    }

    const data = await proxyRes.json();
    const result = data?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: `No chart data for ${symbol}` });

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
      return res.status(422).json({
        error: `Only ${candles.length} candles returned for ${symbol} — need 60+. The proxy may not support range=1y.`,
      });

    return res.status(200).json({ symbol: raw, candles });

  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal error" });
  }
};
