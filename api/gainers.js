// api/gainers.js
// Scan 3: Top Gainers — Daily, Monthly, 3-Month
// Universe: Nifty 500
// Daily: NSE live gainers API
// Monthly/3M: Yahoo Finance historical prices → calculate % change

const { fetchNSE, fetchYahoo, sendError, sendOk, sleep } = require('./_utils');
const { getNifty500 } = require('./nifty500');

// Separate caches per period
const cache = { daily: null, monthly: null, '3month': null };
const cacheAt = { daily: 0, monthly: 0, '3month': 0 };
const TTL = { daily: 5 * 60 * 1000, monthly: 30 * 60 * 1000, '3month': 30 * 60 * 1000 };

async function getDailyGainers() {
  if (cache.daily && Date.now() - cacheAt.daily < TTL.daily) return cache.daily;

  // NSE live market gainers
  const data = await fetchNSE('/api/live-analysis-variations?index=gainers&type=securities');
  
  if (!data) throw new Error('NSE gainers API returned empty response');

  // NSE returns { NIFTY: [...], BANKNIFTY: [...], Securities: [...] }
  // We want the main securities list
  const rawList = data.Securities || data.data || data || [];
  
  if (!Array.isArray(rawList)) throw new Error('Unexpected NSE gainers format');

  // Get Nifty 500 universe for filtering
  const n500 = await getNifty500();
  const n500Set = new Set(n500.map(s => s.symbol));
  const sectorMap = {};
  n500.forEach(s => { sectorMap[s.symbol] = s.sector; });
  const nameMap = {};
  n500.forEach(s => { nameMap[s.symbol] = s.company; });

  const gainers = rawList
    .filter(s => n500Set.has(s.symbol))
    .map(s => ({
      symbol: s.symbol,
      name: nameMap[s.symbol] || s.companyName || s.symbol,
      sector: sectorMap[s.symbol] || 'N/A',
      price: parseFloat(s.ltp || s.lastPrice || 0),
      change_pct: parseFloat(s.perChange || s.pChange || 0),
      extra: formatVolume(s.tradedQuantity || s.totalTradedVolume),
      mcap: null, // filled by fundamentals endpoint
      pe: null,
      avg_val: null
    }))
    .filter(s => s.change_pct > 0)
    .sort((a, b) => b.change_pct - a.change_pct)
    .slice(0, 20);

  cache.daily = gainers;
  cacheAt.daily = Date.now();
  return gainers;
}

async function getPeriodGainers(period) {
  const cacheKey = period; // 'monthly' or '3month'
  if (cache[cacheKey] && Date.now() - cacheAt[cacheKey] < TTL[cacheKey]) return cache[cacheKey];

  const n500 = await getNifty500();
  const sectorMap = {};
  n500.forEach(s => { sectorMap[s.symbol] = s.sector; });

  const range = period === 'monthly' ? '1mo' : '3mo';
  const daysAgo = period === 'monthly' ? 21 : 63; // trading days approx

  // Fetch historical data for all Nifty 500 — compute % change
  const BATCH = 10;
  const results = [];

  for (let i = 0; i < n500.length; i += BATCH) {
    const batch = n500.slice(i, i + BATCH);
    const fetched = await Promise.allSettled(
      batch.map(s => fetchYahoo(s.symbol, range, '1d'))
    );

    for (let j = 0; j < batch.length; j++) {
      const stock = batch[j];
      const r = fetched[j];
      if (r.status !== 'fulfilled' || !r.value) continue;

      const chart = r.value;
      const closes = chart.indicators?.quote?.[0]?.close?.filter(c => c !== null);
      if (!closes || closes.length < 2) continue;

      const startPrice = closes[0];
      const endPrice = closes[closes.length - 1];
      if (!startPrice || startPrice === 0) continue;

      const changePct = ((endPrice - startPrice) / startPrice) * 100;

      results.push({
        symbol: stock.symbol,
        name: stock.company,
        sector: sectorMap[stock.symbol] || 'N/A',
        price: Math.round(endPrice * 100) / 100,
        change_pct: Math.round(changePct * 10) / 10,
        extra: `₹${Math.round(startPrice * 100) / 100}`, // price N days ago
        mcap: null,
        pe: null,
        avg_val: null
      });
    }

    if (i + BATCH < n500.length) await sleep(150);
  }

  const gainers = results
    .filter(s => s.change_pct > 0)
    .sort((a, b) => b.change_pct - a.change_pct)
    .slice(0, 20);

  cache[cacheKey] = gainers;
  cacheAt[cacheKey] = Date.now();
  return gainers;
}

function formatVolume(v) {
  if (!v) return 'N/A';
  const n = parseInt(v);
  if (n >= 10000000) return (n / 10000000).toFixed(1) + 'Cr';
  if (n >= 100000) return (n / 100000).toFixed(1) + 'L';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const period = req.query.period || 'daily'; // daily | monthly | 3month
  const priceMin = parseFloat(req.query.price_min) || 20;
  const mcapMin = parseFloat(req.query.mcap_min) || 1000;
  const mcapMax = parseFloat(req.query.mcap_max) || 50000;
  const peMax = parseFloat(req.query.pe_max) || 35;
  const valMin = parseFloat(req.query.val_min) || 5;

  if (!['daily', 'monthly', '3month'].includes(period)) {
    return sendError(res, 400, 'Invalid period. Use: daily | monthly | 3month');
  }

  try {
    let gainers;
    if (period === 'daily') {
      gainers = await getDailyGainers();
    } else {
      gainers = await getPeriodGainers(period);
    }

    // Apply available filters
    const filtered = gainers.filter(s => {
      if (s.price < priceMin) return false;
      return true;
      // MCap, PE, avg_val require fundamentals lookup — done by frontend
      // after receiving this data via /api/fundamentals?symbols=...
    });

    return sendOk(res, { count: filtered.length, stocks: filtered, period });

  } catch (e) {
    console.error('Gainers scan error:', e.message);
    return sendError(res, 500, 'Gainers scan failed: ' + e.message);
  }
};
