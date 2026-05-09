// api/rs.js
// Scan 2: Relative Strength
// MarketSmith methodology: 12-month performance split into 4 quarters
// Most recent quarter weighted 2x. Rank all stocks → percentile = RS Rating.
// Universe for ranking: Nifty 500. Scan applies to all NSE stocks.
// Filters: RS > threshold, price within X% of 52WH, price > EMA200

const { fetchYahoo, calcEMA, calcRS, sendError, sendOk, sleep } = require('./_utils');
const { getNifty500 } = require('./nifty500');

// Cache: RS scores are expensive to compute, cache 1 hour
let rsCache = null;
let rsCacheAt = 0;
const RS_TTL = 60 * 60 * 1000;

async function buildRSRankings() {
  if (rsCache && Date.now() - rsCacheAt < RS_TTL) return rsCache;

  const nifty500 = await getNifty500();
  const scores = [];

  // Fetch 1-year daily price data for all Nifty 500 stocks
  // Process in batches to avoid rate limiting
  const BATCH = 10;
  for (let i = 0; i < nifty500.length; i += BATCH) {
    const batch = nifty500.slice(i, i + BATCH);

    const results = await Promise.allSettled(
      batch.map(s => fetchYahoo(s.symbol, '1y', '1d'))
    );

    for (let j = 0; j < batch.length; j++) {
      const stock = batch[j];
      const r = results[j];
      if (r.status !== 'fulfilled' || !r.value) continue;

      const chart = r.value;
      const closes = chart.indicators?.quote?.[0]?.close?.filter(c => c !== null);
      if (!closes || closes.length < 60) continue;

      const rsScore = calcRS(closes);
      if (rsScore === null) continue;

      const price = closes[closes.length - 1];
      const high52w = Math.max(...closes);
      const ema200 = calcEMA(closes, 200);
      const fromHigh = ((high52w - price) / high52w) * 100;

      scores.push({
        symbol: stock.symbol,
        name: stock.company,
        sector: stock.sector || 'N/A',
        rsScore,
        price: Math.round(price * 100) / 100,
        wh52: Math.round(high52w * 100) / 100,
        from_wh: Math.round(fromHigh * 10) / 10,
        ema200,
        closes
      });
    }

    if (i + BATCH < nifty500.length) await sleep(200);
  }

  // Rank by RS score → assign percentile 1-99
  scores.sort((a, b) => a.rsScore - b.rsScore);
  scores.forEach((s, idx) => {
    s.rs = Math.round((idx / (scores.length - 1)) * 98) + 1;
  });

  rsCache = scores;
  rsCacheAt = Date.now();
  return scores;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rsMin = parseFloat(req.query.rs_min) || 80;
  const from52whMax = parseFloat(req.query.from_52wh) || 10; // % from 52WH
  const mcapMin = parseFloat(req.query.mcap_min) || 1000;
  const mcapMax = parseFloat(req.query.mcap_max) || 50000;
  const priceMin = parseFloat(req.query.price_min) || 20;
  const peMax = parseFloat(req.query.pe_max) || 35;
  const valMin = parseFloat(req.query.val_min) || 5;

  try {
    const allScores = await buildRSRankings();

    // Apply scan criteria
    const filtered = allScores
      .filter(s => {
        if (s.rs < rsMin) return false;
        if (s.from_wh > from52whMax) return false;
        if (!s.ema200 || s.price < s.ema200) return false;
        if (s.price < priceMin) return false;
        // MCap and PE require Screener lookup - return true here,
        // frontend can re-filter with global filters applied server-side
        // For now return all RS/52WH/EMA qualified stocks
        return true;
      })
      .sort((a, b) => b.rs - a.rs)
      .map(s => ({
        symbol: s.symbol,
        name: s.name,
        sector: s.sector,
        rs: s.rs,
        price: s.price,
        wh52: s.wh52,
        from_wh: s.from_wh,
        ema200: s.ema200,
        // MCap, PE, avg_val fetched separately by /api/fundamentals for selected stocks
        mcap: null,
        pe: null,
        avg_val: null
      }));

    return sendOk(res, {
      count: filtered.length,
      stocks: filtered,
      ranked_universe: allScores.length,
      note: 'MCap/PE data requires fundamentals endpoint. RS calculated using MarketSmith 12-month weighted methodology.'
    });

  } catch (e) {
    console.error('RS scan error:', e.message);
    return sendError(res, 500, 'RS scan failed: ' + e.message);
  }
};
