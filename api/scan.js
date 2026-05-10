// api/scan.js  — Vercel serverless function
// GET /api/scan?symbol=RELIANCE
// Returns: { symbol, candles: [{date,open,high,low,close,volume},...] }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const symbol = (req.query.symbol || "").toUpperCase().trim();
  if (!symbol) return res.status(400).json({ error: "symbol required" });

  const yfUrl = `https://query1.finance.yahoo.com/v8/chart/${symbol}.NS?interval=1d&range=1y`;

  try {
    // Step 1 — get crumb cookie (Yahoo Finance requires this)
    const cookieRes = await fetch("https://finance.yahoo.com", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Accept: "text/html",
      },
    });
    const rawCookie = cookieRes.headers.get("set-cookie") || "";
    const cookie = rawCookie.split(";")[0];

    // Step 2 — get crumb
    let crumb = "";
    try {
      const crumbRes = await fetch(
        "https://query1.finance.yahoo.com/v1/test/getcrumb",
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
            Cookie: cookie,
          },
        }
      );
      crumb = await crumbRes.text();
    } catch (_) {}

    // Step 3 — fetch chart data
    const chartUrl =
      crumb
        ? `${yfUrl}&crumb=${encodeURIComponent(crumb)}`
        : yfUrl;

    const chartRes = await fetch(chartUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Accept: "application/json",
        Cookie: cookie,
      },
    });

    if (!chartRes.ok)
      return res
        .status(chartRes.status)
        .json({ error: `Yahoo returned ${chartRes.status}` });

    const data = await chartRes.json();
    const r = data?.chart?.result?.[0];
    if (!r) return res.status(404).json({ error: "No data for symbol" });

    const {
      timestamp,
      indicators: {
        quote: [q],
      },
    } = r;

    const candles = [];
    for (let i = 0; i < timestamp.length; i++) {
      if (q.close[i] == null || q.high[i] == null || q.low[i] == null)
        continue;
      candles.push({
        date: new Date(timestamp[i] * 1000).toISOString().slice(0, 10),
        open: q.open[i],
        high: q.high[i],
        low: q.low[i],
        close: q.close[i],
        volume: q.volume[i] ?? 0,
      });
    }

    if (candles.length < 60)
      return res
        .status(422)
        .json({ error: `Only ${candles.length} candles — need 60+` });

    return res.status(200).json({ symbol, candles });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
