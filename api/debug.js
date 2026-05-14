// api/debug.js — temporary, shows raw stooq response
// GET /api/debug?symbol=RELIANCE

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
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const raw = ((req.query && req.query.symbol) || "RELIANCE").trim().toUpperCase();
  const stooqSym = raw.toLowerCase().replace(/\.ns$/, "") + ".ns";
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`;

  try {
    const { status, headers, body } = await httpsGet(url);
    return res.status(200).json({
      stooqUrl: url,
      httpStatus: status,
      contentType: headers["content-type"],
      bodyLength: body.length,
      first300chars: body.slice(0, 300),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
