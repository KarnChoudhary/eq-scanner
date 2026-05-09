// rs.js v4 — Yahoo Finance confirmed working ✅, no changes needed to logic
const { fetchYahoo, calcEMA, calcRS, sleep, sendError, sendOk } = require('./_utils');
const { getNifty500 } = require('./nifty500');

let rsCache = null, rsCacheAt = 0;
const RS_TTL = 60 * 60 * 1000;

async function buildRS(log) {
  if (rsCache && Date.now() - rsCacheAt < RS_TTL) return rsCache;
  const n500 = await getNifty500(log);
  log.push('RS universe: ' + n500.length + ' stocks');
  const scores = [];
  const BATCH = 10;

  for (let i = 0; i < n500.length; i += BATCH) {
    const batch = n500.slice(i, i + BATCH);
    const res = await Promise.allSettled(batch.map(s => fetchYahoo(s.symbol, '1y', '1d')));
    for (let j = 0; j < batch.length; j++) {
      const stock = batch[j], r = res[j];
      if (r.status !== 'fulfilled' || !r.value) continue;
      const closes = r.value.indicators?.quote?.[0]?.close?.filter(c => c != null);
      if (!closes || closes.length < 60) continue;
      const rsScore = calcRS(closes); if (rsScore === null) continue;
      const price  = closes[closes.length - 1];
      const high52 = Math.max(...closes);
      const ema200 = calcEMA(closes, Math.min(200, closes.length - 1));
      scores.push({
        symbol: stock.symbol, name: stock.company, sector: stock.sector || 'N/A',
        rsScore, price: Math.round(price*100)/100,
        wh52: Math.round(high52*100)/100,
        from_wh: Math.round(((high52-price)/high52)*1000)/10,
        ema200
      });
    }
    if (i + BATCH < n500.length) await sleep(60);
  }

  scores.sort((a, b) => a.rsScore - b.rsScore);
  scores.forEach((s, i) => { s.rs = Math.round((i / (scores.length - 1)) * 98) + 1; });
  rsCache = scores; rsCacheAt = Date.now();
  log.push('RS done: ' + scores.length + ' stocks ranked');
  return scores;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const rsMin     = parseFloat(req.query.rs_min)    || 80;
  const from52Max = parseFloat(req.query.from_52wh) || 10;
  const priceMin  = parseFloat(req.query.price_min) || 20;
  const log = [];
  try {
    const all = await buildRS(log);
    const filtered = all
      .filter(s => s.rs >= rsMin && s.from_wh <= from52Max && s.ema200 && s.price > s.ema200 && s.price >= priceMin)
      .sort((a, b) => b.rs - a.rs)
      .map(s => ({ ...s, mcap: null, pe: null, avg_val: null }));
    return sendOk(res, { count: filtered.length, stocks: filtered, diag: log });
  } catch (e) { return sendError(res, 500, 'RS failed: ' + e.message); }
};
