// gainers.js v4
// Yahoo Finance confirmed working ✅ — use as primary for ALL periods
// NSE proxy times out — use Yahoo 1d change for daily gainers too
// This is accurate and reliable

const { fetchYahoo, sleep, sendError, sendOk } = require('./_utils');
const { getNifty500 } = require('./nifty500');

const cache    = { daily: null, monthly: null, '3month': null };
const cacheAt  = { daily: 0, monthly: 0, '3month': 0 };
const TTL      = { daily: 10 * 60 * 1000, monthly: 30 * 60 * 1000, '3month': 30 * 60 * 1000 };

const RANGE_MAP = { daily: '5d', monthly: '1mo', '3month': '3mo' };

async function getGainers(period, log) {
  if (cache[period] && Date.now() - cacheAt[period] < TTL[period]) return cache[period];

  const n500 = await getNifty500(log);
  const sectorMap = Object.fromEntries(n500.map(s => [s.symbol, s.sector]));
  const nameMap   = Object.fromEntries(n500.map(s => [s.symbol, s.company]));
  const range     = RANGE_MAP[period];

  log.push('Fetching ' + period + ' gainers via Yahoo (' + n500.length + ' stocks, range=' + range + ')');

  const results = [];
  const BATCH   = 10;

  for (let i = 0; i < n500.length; i += BATCH) {
    const batch = n500.slice(i, i + BATCH);
    const fetched = await Promise.allSettled(
      batch.map(s => fetchYahoo(s.symbol, range, '1d'))
    );

    for (let j = 0; j < batch.length; j++) {
      const stock = batch[j];
      const r     = fetched[j];
      if (r.status !== 'fulfilled' || !r.value) continue;

      const closes = r.value.indicators?.quote?.[0]?.close?.filter(c => c != null);
      if (!closes || closes.length < 2) continue;

      let startPrice, endPrice, extra;

      if (period === 'daily') {
        // Day-over-day change using last two closes
        startPrice = closes[closes.length - 2];
        endPrice   = closes[closes.length - 1];
        // Volume for daily
        const vols = r.value.indicators?.quote?.[0]?.volume?.filter(v => v != null);
        const vol  = vols ? vols[vols.length - 1] : 0;
        extra = fmtVol(vol);
      } else {
        // Period start to end
        startPrice = closes[0];
        endPrice   = closes[closes.length - 1];
        extra = '₹' + startPrice.toFixed(2);
      }

      if (!startPrice || startPrice === 0) continue;
      const changePct = ((endPrice - startPrice) / startPrice) * 100;
      if (changePct <= 0) continue;

      results.push({
        symbol:     stock.symbol,
        name:       nameMap[stock.symbol] || stock.company,
        sector:     sectorMap[stock.symbol] || 'N/A',
        price:      Math.round(endPrice * 100) / 100,
        change_pct: Math.round(changePct * 10) / 10,
        extra,
        mcap: null, pe: null, avg_val: null
      });
    }

    if (i + BATCH < n500.length) await sleep(60);
  }

  const gainers = results
    .sort((a, b) => b.change_pct - a.change_pct)
    .slice(0, 20);

  log.push(period + ' gainers: ' + gainers.length + ' from ' + results.length + ' positive');
  cache[period] = gainers;
  cacheAt[period] = Date.now();
  return gainers;
}

function fmtVol(v) {
  if (!v) return 'N/A';
  const n = parseInt(v);
  if (isNaN(n)) return 'N/A';
  if (n >= 10000000) return (n / 10000000).toFixed(1) + 'Cr';
  if (n >= 100000)   return (n / 100000).toFixed(1) + 'L';
  return (n / 1000).toFixed(0) + 'K';
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const period   = req.query.period || 'daily';
  const priceMin = parseFloat(req.query.price_min) || 20;
  if (!['daily', 'monthly', '3month'].includes(period))
    return sendError(res, 400, 'Invalid period. Use: daily | monthly | 3month');

  const log = [];
  try {
    const gainers  = await getGainers(period, log);
    const filtered = gainers.filter(s => s.price >= priceMin);
    return sendOk(res, { count: filtered.length, stocks: filtered, period, diag: log });
  } catch (e) {
    return sendError(res, 500, 'Gainers failed: ' + e.message);
  }
};
