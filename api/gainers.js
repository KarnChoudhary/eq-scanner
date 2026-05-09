// api/gainers.js v3
// NSE gainers response has keys: legends,NIFTY,BANKNIFTY,NIFTYNEXT50,SecGtr20,SecLwr20,FOSec,allSec
// allSec contains ALL securities — we filter to Nifty500
// Also using Yahoo Finance as reliable fallback

const { fetchViaProxy, fetchDirect, fetchYahoo, sleep, sendError, sendOk } = require('./_utils');
const { getNifty500 } = require('./nifty500');

const cache = { daily: null, monthly: null, '3month': null };
const cacheAt = { daily: 0, monthly: 0, '3month': 0 };
const TTL = { daily: 5 * 60 * 1000, monthly: 30 * 60 * 1000, '3month': 30 * 60 * 1000 };

function fmtVol(v) {
  if (!v) return 'N/A';
  const n = parseInt(v);
  if (isNaN(n)) return 'N/A';
  if (n >= 10000000) return (n / 10000000).toFixed(1) + 'Cr';
  if (n >= 100000)   return (n / 100000).toFixed(1) + 'L';
  return (n / 1000).toFixed(0) + 'K';
}

function norm(item) {
  return {
    symbol:     (item.symbol || item.Symbol || item.SYMBOL || '').trim().toUpperCase(),
    name:        item.companyName || item.company || item.COMPANY || item.name || '',
    price:       parseFloat(item.ltp || item.LTP || item.lastPrice || item.LAST || item.close || 0),
    change_pct:  parseFloat(item.perChange || item.pChange || item.PERCENT_CHANGE || item.per_change || 0),
    volume:      item.tradedQuantity || item.VOLUME || item.totalTradedVolume || item.TOTTRDQTY || 0
  };
}

async function getDailyGainers(log) {
  if (cache.daily && Date.now() - cacheAt.daily < TTL.daily) return cache.daily;

  const n500 = await getNifty500(log);
  const n500Set = new Set(n500.map(s => s.symbol));
  const sectorMap = Object.fromEntries(n500.map(s => [s.symbol, s.sector]));
  const nameMap   = Object.fromEntries(n500.map(s => [s.symbol, s.company]));

  // Try NSE via proxy — the response has 'allSec' key with all securities
  let rawList = [];
  const nseUrls = [
    'https://www.nseindia.com/api/live-analysis-variations?index=gainers&type=securities',
    'https://www.nseindia.com/api/live-analysis-variations?index=gainers',
  ];

  for (const url of nseUrls) {
    try {
      const data = await fetchViaProxy(url, true);
      log.push('NSE gainers keys: ' + Object.keys(data || {}).join(','));

      // From health check we know keys are: legends,NIFTY,BANKNIFTY,NIFTYNEXT50,SecGtr20,SecLwr20,FOSec,allSec
      // allSec has ALL securities — use it and filter to Nifty500
      let candidates = [];
      if (Array.isArray(data?.allSec?.data)) candidates = data.allSec.data;
      else if (Array.isArray(data?.allSec)) candidates = data.allSec;
      else if (Array.isArray(data?.Securities?.data)) candidates = data.Securities.data;
      else if (Array.isArray(data?.Securities)) candidates = data.Securities;
      else if (Array.isArray(data?.data)) candidates = data.data;
      else if (Array.isArray(data)) candidates = data;
      else {
        // Search all keys for largest array
        let best = [];
        for (const k of Object.keys(data || {})) {
          const v = data[k];
          const arr = Array.isArray(v) ? v : Array.isArray(v?.data) ? v.data : null;
          if (arr && arr.length > best.length) best = arr;
        }
        candidates = best;
      }

      log.push('NSE allSec candidates: ' + candidates.length);
      if (candidates.length > 0) { rawList = candidates; break; }
    } catch (e) { log.push('NSE gainers proxy failed: ' + e.message); }
  }

  if (rawList.length > 0) {
    const gainers = rawList
      .map(norm)
      .filter(s => n500Set.has(s.symbol) && s.change_pct > 0)
      .sort((a, b) => b.change_pct - a.change_pct)
      .slice(0, 20)
      .map(s => ({
        symbol: s.symbol,
        name: nameMap[s.symbol] || s.name || s.symbol,
        sector: sectorMap[s.symbol] || 'N/A',
        price: Math.round(s.price * 100) / 100,
        change_pct: Math.round(s.change_pct * 10) / 10,
        extra: fmtVol(s.volume),
        mcap: null, pe: null, avg_val: null
      }));
    log.push('NSE daily gainers found: ' + gainers.length);
    if (gainers.length > 0) { cache.daily = gainers; cacheAt.daily = Date.now(); return gainers; }
  }

  // Fallback: Yahoo Finance 1-day change for all Nifty500
  log.push('Falling back to Yahoo Finance for daily gainers');
  return getDailyGainersYahoo(n500, sectorMap, nameMap, log);
}

async function getDailyGainersYahoo(n500, sectorMap, nameMap, log) {
  const results = [];
  const BATCH = 8;
  for (let i = 0; i < n500.length; i += BATCH) {
    const batch = n500.slice(i, i + BATCH);
    const fetched = await Promise.allSettled(batch.map(s => fetchYahoo(s.symbol, '5d', '1d')));
    for (let j = 0; j < batch.length; j++) {
      const stock = batch[j];
      const r = fetched[j];
      if (r.status !== 'fulfilled' || !r.value) continue;
      const closes = r.value.indicators?.quote?.[0]?.close?.filter(c => c != null);
      if (!closes || closes.length < 2) continue;
      const price = closes[closes.length - 1];
      const prev  = closes[closes.length - 2];
      if (!prev || prev === 0) continue;
      const change_pct = ((price - prev) / prev) * 100;
      if (change_pct <= 0) continue;
      results.push({
        symbol: stock.symbol,
        name: nameMap[stock.symbol] || stock.company,
        sector: sectorMap[stock.symbol] || 'N/A',
        price: Math.round(price * 100) / 100,
        change_pct: Math.round(change_pct * 10) / 10,
        extra: 'N/A', mcap: null, pe: null, avg_val: null
      });
    }
    if (i + BATCH < n500.length) await sleep(80);
  }
  const gainers = results.sort((a, b) => b.change_pct - a.change_pct).slice(0, 20);
  log.push('Yahoo daily gainers: ' + gainers.length);
  cache.daily = gainers; cacheAt.daily = Date.now();
  return gainers;
}

async function getPeriodGainers(period, log) {
  if (cache[period] && Date.now() - cacheAt[period] < TTL[period]) return cache[period];
  const n500 = await getNifty500(log);
  const sectorMap = Object.fromEntries(n500.map(s => [s.symbol, s.sector]));
  const nameMap   = Object.fromEntries(n500.map(s => [s.symbol, s.company]));
  const range = period === 'monthly' ? '1mo' : '3mo';
  const results = [];
  const BATCH = 8;

  for (let i = 0; i < n500.length; i += BATCH) {
    const batch = n500.slice(i, i + BATCH);
    const fetched = await Promise.allSettled(batch.map(s => fetchYahoo(s.symbol, range, '1d')));
    for (let j = 0; j < batch.length; j++) {
      const stock = batch[j];
      const r = fetched[j];
      if (r.status !== 'fulfilled' || !r.value) continue;
      const closes = r.value.indicators?.quote?.[0]?.close?.filter(c => c != null);
      if (!closes || closes.length < 2) continue;
      const start = closes[0], end = closes[closes.length - 1];
      if (!start || start === 0) continue;
      const changePct = ((end - start) / start) * 100;
      if (changePct <= 0) continue;
      results.push({
        symbol: stock.symbol,
        name: nameMap[stock.symbol] || stock.company,
        sector: sectorMap[stock.symbol] || 'N/A',
        price: Math.round(end * 100) / 100,
        change_pct: Math.round(changePct * 10) / 10,
        extra: '₹' + Math.round(start * 100) / 100,
        mcap: null, pe: null, avg_val: null
      });
    }
    if (i + BATCH < n500.length) await sleep(80);
  }

  const gainers = results.sort((a, b) => b.change_pct - a.change_pct).slice(0, 20);
  log.push(period + ' gainers: ' + gainers.length);
  cache[period] = gainers; cacheAt[period] = Date.now();
  return gainers;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const period   = req.query.period || 'daily';
  const priceMin = parseFloat(req.query.price_min) || 20;
  if (!['daily','monthly','3month'].includes(period)) return sendError(res, 400, 'Invalid period');
  const log = [];
  try {
    const g = period === 'daily' ? await getDailyGainers(log) : await getPeriodGainers(period, log);
    const filtered = g.filter(s => s.price >= priceMin);
    return sendOk(res, { count: filtered.length, stocks: filtered, period, diag: log });
  } catch (e) {
    return sendError(res, 500, 'Gainers failed: ' + e.message);
  }
};
