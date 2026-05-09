// api/fundamentals.js v3 — batch fundamentals from Screener HTML
const { fetchScreenerHTML, parseScreenerData, fetchYahoo, sleep, sendError, sendOk } = require('./_utils');

const symCache = {};
const SYM_TTL = 30 * 60 * 1000;

async function getFundamentals(symbol) {
  const cached = symCache[symbol];
  if (cached && Date.now() - cached.at < SYM_TTL) return cached.data;

  // Try Screener HTML
  const result = await fetchScreenerHTML(symbol);
  let data = { mcap: null, pe: null, price: null, sector: 'N/A', avg_val: null };
  if (result) {
    const parsed = parseScreenerData(result.html);
    data = { mcap: parsed.mcap, pe: parsed.pe, price: parsed.price, sector: parsed.sector, avg_val: parsed.avg_val };
  }

  // If price missing, get from Yahoo
  if (!data.price) {
    try {
      const chart = await fetchYahoo(symbol, '5d', '1d');
      const closes = chart?.indicators?.quote?.[0]?.close?.filter(c => c != null);
      if (closes?.length) data.price = Math.round(closes[closes.length-1]*100)/100;
    } catch {}
  }

  symCache[symbol] = { data, at: Date.now() };
  return data;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const symbols = (req.query.symbols||'').split(',').map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,25);
  if (!symbols.length) return sendError(res, 400, 'symbols required');
  try {
    const results = {};
    const BATCH = 4;
    for (let i = 0; i < symbols.length; i += BATCH) {
      const batch = symbols.slice(i, i+BATCH);
      const fetched = await Promise.allSettled(batch.map(s => getFundamentals(s)));
      fetched.forEach((r,j) => { results[batch[j]] = r.status==='fulfilled' ? r.value : { mcap:null,pe:null,price:null,sector:'N/A',avg_val:null }; });
      if (i+BATCH < symbols.length) await sleep(200);
    }
    return sendOk(res, { fundamentals: results });
  } catch (e) { return sendError(res, 500, 'Fundamentals failed: ' + e.message); }
};
