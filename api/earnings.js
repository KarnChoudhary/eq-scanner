// api/earnings.js v3
// NSE direct blocked. Strategy:
// 1. NSE Corporate Results via allorigins proxy
// 2. Screener.in latest results list (direct, usually works)
// 3. Moneycontrol results calendar (direct)
// Quarterly data from Screener HTML per symbol

const { fetchViaProxy, fetchDirect, fetchScreenerHTML, parseScreenerData, sleep, sendError, sendOk } = require('./_utils');

let cache = null, cacheAt = 0;
const TTL = 20 * 60 * 1000;

function within30d(ds) {
  if (!ds) return false;
  try { const d = new Date(ds); const diff = Date.now() - d.getTime(); return !isNaN(d) && diff >= 0 && diff <= 30 * 86400000; }
  catch { return false; }
}
function qoq(c, p) {
  if (c == null || p == null || p === 0) return null;
  return Math.round(((c - p) / Math.abs(p)) * 1000) / 10;
}

// Source 1: NSE via proxy
async function srcNSE(log) {
  const syms = [];
  try {
    const url = 'https://www.nseindia.com/api/corporate-announcements?index=equities&subject=Financial+Results';
    const data = await fetchViaProxy(url, true);
    const rows = Array.isArray(data) ? data : (data?.data || []);
    log.push('NSE results via proxy: ' + rows.length + ' rows');
    for (const r of rows) {
      const dt = r.bcastDt || r.an_dt || r.date || '';
      const sym = (r.symbol || r.Symbol || '').trim().toUpperCase();
      if (sym && within30d(dt)) syms.push({ symbol: sym, result_date: dt.slice(0, 10) });
    }
    log.push('NSE within 30d: ' + syms.length);
  } catch (e) { log.push('NSE proxy failed: ' + e.message); }
  return syms;
}

// Source 2: Screener latest results
async function srcScreener(log) {
  const syms = [];
  try {
    const html = await fetchDirect('https://www.screener.in/screens/latest-results/', false,
      { 'Referer': 'https://www.screener.in/' });
    // Screener latest results page has links like /company/SYMBOL/
    const re = /href="\/company\/([A-Z][A-Z0-9&-]{0,20})\/(?:consolidated\/)?"\s*>[\s\S]{0,300}?((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+\d{1,2},?\s*\d{4}|\d{2}[-\/]\d{2}[-\/]\d{4})/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const sym = m[1].replace('&amp;', '&');
      const dt = m[2];
      if (within30d(dt)) syms.push({ symbol: sym, result_date: dt });
    }
    // Also try simpler pattern - just get all symbols from results page
    if (syms.length < 5) {
      const re2 = /href="\/company\/([A-Z][A-Z0-9&-]{1,20})\/(?:consolidated\/)?"/gi;
      const seen = new Set();
      while ((m = re2.exec(html)) !== null) {
        const sym = m[1].replace('&amp;', '&');
        if (!seen.has(sym) && sym !== 'LOGIN' && sym.length >= 2) {
          seen.add(sym);
          syms.push({ symbol: sym, result_date: new Date().toISOString().slice(0, 10) });
        }
      }
    }
    log.push('Screener latest results: ' + syms.length);
  } catch (e) { log.push('Screener results failed: ' + e.message); }
  return syms;
}

// Source 3: Moneycontrol results
async function srcMoneycontrol(log) {
  const syms = [];
  try {
    const html = await fetchDirect(
      'https://www.moneycontrol.com/markets/earnings/results-calendar/',
      false,
      { 'Referer': 'https://www.moneycontrol.com/' }
    );
    // Try multiple patterns for NSE symbols
    const patterns = [
      /data-nse[_-]?code="([A-Z][A-Z0-9&-]{1,20})"/gi,
      /NSE:([A-Z][A-Z0-9]{1,20})/g,
      /"nse_code"\s*:\s*"([A-Z][A-Z0-9]{1,20})"/gi,
      /\bNSE\|([A-Z][A-Z0-9]{1,20})\b/g,
    ];
    const seen = new Set();
    for (const re of patterns) {
      let m;
      while ((m = re.exec(html)) !== null) {
        const sym = m[1];
        if (!seen.has(sym)) { seen.add(sym); syms.push({ symbol: sym, result_date: new Date().toISOString().slice(0, 10) }); }
      }
    }
    log.push('Moneycontrol: ' + syms.length + ' symbols');
  } catch (e) { log.push('Moneycontrol failed: ' + e.message); }
  return syms;
}

// Source 4: BSE results feed (often more accessible)
async function srcBSE(log) {
  const syms = [];
  try {
    // BSE has public quarterly results data
    const url = 'https://api.bseindia.com/BseIndiaAPI/api/ResultsCalendar/w?fromdate=' +
      new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10).replace(/-/g, '') +
      '&todate=' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '&CategoryID=0';
    const data = await fetchDirect(url, true, { 'Referer': 'https://www.bseindia.com/' });
    const rows = data?.Table || data?.data || data || [];
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const sym = (r.NSE_Symbol || r.nse_symbol || r.SCRIP_CD || '').trim().toUpperCase();
        const dt = r.ResultDate || r.result_date || r.DATE || '';
        if (sym && sym.length > 1) syms.push({ symbol: sym, result_date: dt.slice(0, 10) || new Date().toISOString().slice(0, 10) });
      }
    }
    log.push('BSE results: ' + syms.length);
  } catch (e) { log.push('BSE results failed: ' + e.message); }
  return syms;
}

async function getScreenerQuarterly(symbol, log) {
  const result = await fetchScreenerHTML(symbol);
  if (!result) { log && log.push(symbol + ': screener fetch failed'); return null; }
  const data = parseScreenerData(result.html);
  if (!data.quarters || data.quarters.length < 2) {
    log && log.push(symbol + ': quarters=' + (data.quarters?.length || 0));
    return null;
  }
  return data;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const revThresh = parseFloat(req.query.rev_thresh) || 20;
  const patThresh = parseFloat(req.query.pat_thresh) || 20;
  const mcapMin   = parseFloat(req.query.mcap_min)   || 1000;
  const mcapMax   = parseFloat(req.query.mcap_max)   || 50000;
  const priceMin  = parseFloat(req.query.price_min)  || 20;
  const peMax     = parseFloat(req.query.pe_max)     || 35;
  const valMin    = parseFloat(req.query.val_min)    || 5;

  if (cache && Date.now() - cacheAt < TTL) {
    const f = applyF(cache, { revThresh, patThresh, mcapMin, mcapMax, priceMin, peMax, valMin });
    return sendOk(res, { count: f.length, stocks: f, cached: true });
  }

  const log = [];
  try {
    // Run all 4 sources in parallel
    const [r1, r2, r3, r4] = await Promise.all([srcNSE(log), srcScreener(log), srcMoneycontrol(log), srcBSE(log)]);

    // Deduplicate — prefer results with actual date
    const symMap = new Map();
    for (const s of [...r1, ...r4, ...r2, ...r3]) {
      if (!symMap.has(s.symbol)) symMap.set(s.symbol, s);
    }
    log.push('Total unique symbols: ' + symMap.size);

    if (!symMap.size) {
      return sendOk(res, { count: 0, stocks: [], note: 'No recent results found. All sources returned empty.', diag: log });
    }

    const syms = [...symMap.values()];
    const enriched = [];
    const BATCH = 4;

    for (let i = 0; i < Math.min(syms.length, 80); i += BATCH) {
      const batch = syms.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(s => getScreenerQuarterly(s.symbol, log)));
      for (let j = 0; j < batch.length; j++) {
        const raw = batch[j];
        const r = results[j];
        if (r.status !== 'fulfilled' || !r.value) continue;
        const s = r.value;
        const q0 = s.quarters[0], q1 = s.quarters[1];
        const rQoQ = qoq(q0.revenue, q1.revenue);
        const pQoQ = qoq(q0.pat, q1.pat);
        if (rQoQ === null || pQoQ === null) continue;
        enriched.push({
          symbol: raw.symbol, name: raw.symbol,
          sector: s.sector || 'N/A',
          result_date: raw.result_date,
          revenue: q0.revenue, rev_qoq: rQoQ,
          pat: q0.pat, pat_qoq: pQoQ,
          mcap: s.mcap, pe: s.pe, price: s.price, avg_val: s.avg_val
        });
        log.push(raw.symbol + ': rev=' + rQoQ + '% pat=' + pQoQ + '%');
      }
      if (i + BATCH < syms.length) await sleep(300);
    }

    cache = enriched; cacheAt = Date.now();
    const filtered = applyF(enriched, { revThresh, patThresh, mcapMin, mcapMax, priceMin, peMax, valMin });
    return sendOk(res, { count: filtered.length, stocks: filtered, diag: log });
  } catch (e) {
    return sendError(res, 500, 'Earnings failed: ' + e.message);
  }
};

function applyF(stocks, f) {
  return stocks.filter(s => {
    if (s.rev_qoq < f.revThresh) return false;
    if (s.pat_qoq < f.patThresh) return false;
    if (s.mcap != null && s.mcap < f.mcapMin) return false;
    if (s.mcap != null && s.mcap > f.mcapMax) return false;
    if (s.price != null && s.price < f.priceMin) return false;
    if (s.pe != null && s.pe > f.peMax) return false;
    if (s.avg_val != null && s.avg_val < f.valMin) return false;
    return true;
  }).sort((a, b) => b.pat_qoq - a.pat_qoq);
}
