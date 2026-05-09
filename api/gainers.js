// api/gainers.js v2 — fixed NSE format handling + multiple fallbacks
const { sendError, sendOk, sleep } = require('./_utils');
const { getNifty500 } = require('./nifty500');

const cache = { daily: null, monthly: null, '3month': null };
const cacheAt = { daily: 0, monthly: 0, '3month': 0 };
const TTL = { daily: 5 * 60 * 1000, monthly: 30 * 60 * 1000, '3month': 30 * 60 * 1000 };

let _ck='', _ckat=0;
async function nCk(){
  if(_ck && Date.now()-_ckat < 8*60000) return _ck;
  try {
    const r = await fetch('https://www.nseindia.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'text/html' }
    });
    const sc = r.headers.get('set-cookie') || '';
    _ck = sc.split(',').map(c => c.split(';')[0].trim()).filter(c => c.includes('=')).join('; ');
    _ckat = Date.now();
  } catch {}
  return _ck;
}

const NSE_HDR = (ck) => ({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/',
  'Cookie': ck
});

function fmtVol(v) {
  if (!v) return 'N/A';
  const n = parseInt(v);
  if (isNaN(n)) return 'N/A';
  if (n >= 10000000) return (n/10000000).toFixed(1) + 'Cr';
  if (n >= 100000)   return (n/100000).toFixed(1) + 'L';
  if (n >= 1000)     return (n/1000).toFixed(1) + 'K';
  return String(n);
}

// Normalise a raw NSE security object regardless of which endpoint returned it
function normaliseNSE(item) {
  // Different NSE endpoints use different field names
  return {
    symbol:      (item.symbol || item.Symbol || item.SYMBOL || '').trim().toUpperCase(),
    name:        item.companyName || item.COMPANY || item.name || '',
    price:       parseFloat(item.ltp || item.LTP || item.lastPrice || item.LAST || item.close || 0),
    change_pct:  parseFloat(item.perChange || item.pChange || item.PERCENT_CHANGE || item.change || 0),
    volume:      item.tradedQuantity || item.VOLUME || item.totalTradedVolume || item.TOTTRDQTY || 0
  };
}

async function getDailyGainers(log) {
  if (cache.daily && Date.now() - cacheAt.daily < TTL.daily) return cache.daily;

  const n500 = await getNifty500();
  const n500Set = new Set(n500.map(s => s.symbol));
  const sectorMap = Object.fromEntries(n500.map(s => [s.symbol, s.sector]));
  const nameMap   = Object.fromEntries(n500.map(s => [s.symbol, s.company]));

  const ck = await nCk();

  // Try multiple NSE endpoints for gainers — they restructure APIs occasionally
  const endpoints = [
    '/api/live-analysis-variations?index=gainers&type=securities',
    '/api/live-analysis-variations?index=gainers',
    '/api/equity-stockIndices?index=NIFTY%20500',
    '/api/market-data-pre-open?key=NIFTY500'
  ];

  let rawList = [];
  for (const ep of endpoints) {
    try {
      const r = await fetch('https://www.nseindia.com' + ep, { headers: NSE_HDR(ck) });
      if (!r.ok) { log.push(ep + ' → HTTP ' + r.status); continue; }
      const data = await r.json();
      log.push(ep + ' → keys: ' + Object.keys(data).join(','));

      // NSE returns different shapes — handle all known ones
      let candidates = [];
      if (Array.isArray(data)) candidates = data;
      else if (Array.isArray(data.data)) candidates = data.data;
      else if (Array.isArray(data.Securities)) candidates = data.Securities;
      else if (Array.isArray(data.NIFTY500)) candidates = data.NIFTY500;
      else if (data.advances && Array.isArray(data.advances.data)) candidates = data.advances.data;
      else {
        // search all keys for an array
        for (const k of Object.keys(data)) {
          if (Array.isArray(data[k]) && data[k].length > 5) { candidates = data[k]; break; }
        }
      }

      log.push(ep + ' → candidates: ' + candidates.length);
      if (candidates.length > 0) { rawList = candidates; break; }
    } catch (e) { log.push(ep + ' → error: ' + e.message); }
  }

  if (!rawList.length) {
    log.push('All NSE gainers endpoints failed — falling back to Yahoo');
    return getDailyGainersYahoo(n500, sectorMap, nameMap, log);
  }

  const gainers = rawList
    .map(normaliseNSE)
    .filter(s => n500Set.has(s.symbol) && s.change_pct > 0)
    .sort((a, b) => b.change_pct - a.change_pct)
    .slice(0, 20)
    .map(s => ({
      symbol: s.symbol,
      name: nameMap[s.symbol] || s.name || s.symbol,
      sector: sectorMap[s.symbol] || 'N/A',
      price: s.price,
      change_pct: Math.round(s.change_pct * 10) / 10,
      extra: fmtVol(s.volume),
      mcap: null, pe: null, avg_val: null
    }));

  log.push('Daily gainers final: ' + gainers.length);
  cache.daily = gainers;
  cacheAt.daily = Date.now();
  return gainers;
}

// Yahoo Finance fallback for daily gainers
async function getDailyGainersYahoo(n500, sectorMap, nameMap, log) {
  log.push('Yahoo daily fallback: fetching 1d data for Nifty500...');
  const BATCH = 10;
  const results = [];

  for (let i = 0; i < n500.length; i += BATCH) {
    const batch = n500.slice(i, i + BATCH);
    const fetched = await Promise.allSettled(batch.map(s => fetchYahoo1d(s.symbol)));
    for (let j = 0; j < batch.length; j++) {
      const stock = batch[j];
      const r = fetched[j];
      if (r.status !== 'fulfilled' || !r.value) continue;
      const { price, change_pct } = r.value;
      if (change_pct <= 0) continue;
      results.push({
        symbol: stock.symbol,
        name: nameMap[stock.symbol] || stock.company,
        sector: sectorMap[stock.symbol] || 'N/A',
        price, change_pct: Math.round(change_pct * 10) / 10,
        extra: 'N/A', mcap: null, pe: null, avg_val: null
      });
    }
    if (i + BATCH < n500.length) await sleep(100);
  }

  const gainers = results.sort((a, b) => b.change_pct - a.change_pct).slice(0, 20);
  cache.daily = gainers; cacheAt.daily = Date.now();
  return gainers;
}

async function fetchYahoo1d(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.NS?range=5d&interval=1d&includePrePost=false`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    if (!r.ok) return null;
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const closes = result.indicators?.quote?.[0]?.close?.filter(c => c != null);
    if (!closes || closes.length < 2) return null;
    const price = closes[closes.length - 1];
    const prev  = closes[closes.length - 2];
    const change_pct = prev > 0 ? ((price - prev) / prev) * 100 : 0;
    return { price: Math.round(price * 100) / 100, change_pct };
  } catch { return null; }
}

async function getPeriodGainers(period, log) {
  if (cache[period] && Date.now() - cacheAt[period] < TTL[period]) return cache[period];

  const n500 = await getNifty500();
  const sectorMap = Object.fromEntries(n500.map(s => [s.symbol, s.sector]));
  const range = period === 'monthly' ? '1mo' : '3mo';
  const BATCH = 10;
  const results = [];

  for (let i = 0; i < n500.length; i += BATCH) {
    const batch = n500.slice(i, i + BATCH);
    const fetched = await Promise.allSettled(batch.map(s => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${s.symbol}.NS?range=${range}&interval=1d&includePrePost=false`;
      return fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } })
        .then(r => r.ok ? r.json() : null).catch(() => null);
    }));

    for (let j = 0; j < batch.length; j++) {
      const stock = batch[j];
      const r = fetched[j];
      if (r.status !== 'fulfilled' || !r.value) continue;
      const result = r.value?.chart?.result?.[0];
      if (!result) continue;
      const closes = result.indicators?.quote?.[0]?.close?.filter(c => c != null);
      if (!closes || closes.length < 2) continue;
      const startPrice = closes[0];
      const endPrice   = closes[closes.length - 1];
      if (!startPrice || startPrice === 0) continue;
      const changePct  = ((endPrice - startPrice) / startPrice) * 100;
      if (changePct <= 0) continue;
      results.push({
        symbol: stock.symbol, name: stock.company,
        sector: sectorMap[stock.symbol] || 'N/A',
        price: Math.round(endPrice * 100) / 100,
        change_pct: Math.round(changePct * 10) / 10,
        extra: '₹' + Math.round(startPrice * 100) / 100,
        mcap: null, pe: null, avg_val: null
      });
    }
    if (i + BATCH < n500.length) await sleep(120);
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
  const mcapMin  = parseFloat(req.query.mcap_min)  || 1000;
  const mcapMax  = parseFloat(req.query.mcap_max)  || 50000;
  const peMax    = parseFloat(req.query.pe_max)    || 35;
  const valMin   = parseFloat(req.query.val_min)   || 5;

  if (!['daily','monthly','3month'].includes(period))
    return sendError(res, 400, 'Invalid period');

  const log = [];
  try {
    const gainers = period === 'daily'
      ? await getDailyGainers(log)
      : await getPeriodGainers(period, log);

    const filtered = gainers.filter(s => s.price >= priceMin);
    return sendOk(res, { count: filtered.length, stocks: filtered, period, diag: log });
  } catch (e) {
    console.error('Gainers error:', e);
    return sendError(res, 500, 'Gainers failed: ' + e.message);
  }
};
