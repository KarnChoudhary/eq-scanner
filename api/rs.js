// api/rs.js v3 — uses Yahoo Finance (confirmed working) + hardcoded Nifty500 fallback
const { fetchYahoo, calcEMA, calcRS, sleep, sendError, sendOk } = require('./_utils');
const { getNifty500 } = require('./nifty500');

let rsCache = null, rsCacheAt = 0;
const RS_TTL = 60 * 60 * 1000;

async function buildRSRankings(log) {
  if (rsCache && Date.now() - rsCacheAt < RS_TTL) return rsCache;
  const n500 = await getNifty500(log);
  log.push('RS universe: ' + n500.length + ' stocks');
  const scores = [];
  const BATCH = 8;

  for (let i = 0; i < n500.length; i += BATCH) {
    const batch = n500.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(s => fetchYahoo(s.symbol, '1y', '1d')));
    for (let j = 0; j < batch.length; j++) {
      const stock = batch[j];
      const r = results[j];
      if (r.status !== 'fulfilled' || !r.value) continue;
      const closes = r.value.indicators?.quote?.[0]?.close?.filter(c => c != null);
      if (!closes || closes.length < 60) continue;
      const rsScore = calcRS(closes);
      if (rsScore === null) continue;
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
    if (i + BATCH < n500.length) await sleep(80);
  }

  scores.sort((a, b) => a.rsScore - b.rsScore);
  scores.forEach((s, idx) => { s.rs = Math.round((idx / (scores.length - 1)) * 98) + 1; });
  rsCache = scores; rsCacheAt = Date.now();
  log.push('RS computed for ' + scores.length + ' stocks');
  return scores;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const rsMin      = parseFloat(req.query.rs_min)    || 80;
  const from52Max  = parseFloat(req.query.from_52wh) || 10;
  const mcapMin    = parseFloat(req.query.mcap_min)  || 1000;
  const mcapMax    = parseFloat(req.query.mcap_max)  || 50000;
  const priceMin   = parseFloat(req.query.price_min) || 20;
  const peMax      = parseFloat(req.query.pe_max)    || 35;
  const valMin     = parseFloat(req.query.val_min)   || 5;
  const log = [];
  try {
    const all = await buildRSRankings(log);
    const filtered = all.filter(s =>
      s.rs >= rsMin && s.from_wh <= from52Max && s.ema200 && s.price > s.ema200 && s.price >= priceMin
    ).sort((a, b) => b.rs - a.rs)
     .map(s => ({ ...s, mcap: null, pe: null, avg_val: null }));
    return sendOk(res, { count: filtered.length, stocks: filtered, diag: log });
  } catch (e) {
    return sendError(res, 500, 'RS failed: ' + e.message);
  }
};
