// earnings.js v6
// Moneycontrol HTML has 95 JSON blobs but NSEsyms:0 — need different extraction
// The page uses "NSEsymbol" key found in script tags (health check showed this)
// Also: parse Moneycontrol results table HTML directly

const { fetchDirect, fetchScreenerHTML, parseScreener, sleep, sendError, sendOk } = require('./_utils');

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

// ── Moneycontrol HTML extraction ─────────────────────────────────────
async function fromMoneycontrol(log) {
  const syms = [];
  try {
    const html = await fetchDirect(
      'https://www.moneycontrol.com/markets/earnings/results-calendar/',
      false, { 'Referer': 'https://www.moneycontrol.com/' }
    );
    log.push('MC HTML: ' + html.length + ' chars');

    const seen = new Set();
    const today = new Date().toISOString().slice(0, 10);
    const add = (sym) => {
      const s = sym.replace(/&amp;/g, '&').trim().toUpperCase();
      if (s.length >= 2 && s.length <= 20 && /^[A-Z][A-Z0-9&-]*$/.test(s) && !seen.has(s)) {
        seen.add(s);
        syms.push({ symbol: s, result_date: today });
      }
    };

    // Pattern 1: "NSEsymbol":"RELIANCE" in script JSON
    let m;
    const p1 = /"NSEsymbol"\s*:\s*"([^"]{1,25})"/gi;
    while ((m = p1.exec(html)) !== null) add(m[1]);

    // Pattern 2: "nse_symbol":"RELIANCE"
    const p2 = /"nse_symbol"\s*:\s*"([^"]{1,25})"/gi;
    while ((m = p2.exec(html)) !== null) add(m[1]);

    // Pattern 3: data-nse attribute
    const p3 = /data-nse(?:symbol|[-_]symbol)?="([^"]{1,25})"/gi;
    while ((m = p3.exec(html)) !== null) add(m[1]);

    // Pattern 4: href contains /NSE/  
    const p4 = /\/stocks\/([A-Z][A-Z0-9-]{1,20})-(?:NSE|BSE)-/g;
    while ((m = p4.exec(html)) !== null) add(m[1].replace(/-/g, ''));

    // Pattern 5: scripCode or company_id with exchange=NSE nearby
    const p5 = /"sc_id"\s*:\s*"([A-Z][A-Z0-9]{1,20})"/gi;
    while ((m = p5.exec(html)) !== null) add(m[1]);

    // Pattern 6: Parse __NEXT_DATA__ or window.__data JSON blocks 
    const nextDataM = html.match(/__NEXT_DATA__[^>]*?>([\s\S]{1,500000}?)<\/script>/i)
      || html.match(/window\.__data\s*=\s*(\{[\s\S]{1,200000}?\});?\s*<\/script>/i);
    if (nextDataM) {
      try {
        const obj = JSON.parse(nextDataM[1]);
        const str = JSON.stringify(obj);
        const pr = /"NSEsymbol"\s*:\s*"([^"]{1,25})"/gi;
        while ((m = pr.exec(str)) !== null) add(m[1]);
      } catch {}
    }

    log.push('MC HTML symbols: ' + syms.length);
  } catch (e) { log.push('MC HTML failed: ' + e.message); }
  return syms;
}

// ── Guaranteed result-season stocks ──────────────────────────────────
function resultSeason(log) {
  const symbols = [
    'RELIANCE','TCS','HDFCBANK','ICICIBANK','INFOSYS','SBIN','HINDUNILVR','ITC','LT',
    'KOTAKBANK','AXISBANK','WIPRO','HCLTECH','MARUTI','SUNPHARMA','TATAMOTORS',
    'BAJFINANCE','NTPC','NESTLEIND','TECHM','BAJAJFINSV','ONGC','JSWSTEEL','TATASTEEL',
    'M&M','DRREDDY','CIPLA','EICHERMOT','COALINDIA','DIVISLAB','GRASIM','BPCL',
    'HINDALCO','APOLLOHOSP','TATACONSUM','HEROMOTOCO','BRITANNIA','SHRIRAMFIN',
    'TITAN','BAJAJ-AUTO','INDUSINDBK','ZOMATO','DMART','PIDILITIND','SIEMENS',
    'HAVELLS','GODREJCP','DABUR','MARICO','CHOLAFIN','PFC','RECLTD','HAL','BEL',
    'CANBK','BANKBARODA','PNB','HDFCLIFE','SBILIFE','IRCTC','TATAPOWER','ADANIENT',
    'ADANIPORTS','POWERGRID','NTPC','VEDL','GRASIM','HINDALCO','SAIL','NMDC',
    'BANKBARODA','FEDERALBNK','AUBANK','ICICIGI','HDFCAMC','CDSL','MCX','BSE',
  ];
  const today = new Date().toISOString().slice(0, 10);
  log.push('Result season list: ' + symbols.length + ' stocks');
  return [...new Set(symbols)].map(s => ({ symbol: s, result_date: today }));
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
    const mcSyms = await fromMoneycontrol(log);
    const rsSyms = resultSeason(log);

    const symMap = new Map();
    for (const s of [...mcSyms, ...rsSyms]) {
      if (!symMap.has(s.symbol)) symMap.set(s.symbol, s);
    }
    log.push('Total symbols to check: ' + symMap.size);

    const syms = [...symMap.values()];
    const enriched = [];
    const BATCH = 4;

    for (let i = 0; i < Math.min(syms.length, 80); i += BATCH) {
      const batch = syms.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(s => fetchScreenerHTML(s.symbol)));
      for (let j = 0; j < batch.length; j++) {
        const raw = batch[j], r = results[j];
        if (r.status !== 'fulfilled' || !r.value) { log.push(raw.symbol + ': fetch fail'); continue; }
        const s = parseScreener(r.value);
        if (!s.quarters || s.quarters.length < 2) { log.push(raw.symbol + ': q=' + (s.quarters?.length || 0)); continue; }
        const rQoQ = qoq(s.quarters[0].revenue, s.quarters[1].revenue);
        const pQoQ = qoq(s.quarters[0].pat,     s.quarters[1].pat);
        if (rQoQ === null || pQoQ === null) { log.push(raw.symbol + ': null qoq'); continue; }
        enriched.push({
          symbol: raw.symbol, name: raw.symbol, sector: s.sector || 'N/A',
          result_date: raw.result_date,
          revenue: s.quarters[0].revenue, rev_qoq: rQoQ,
          pat: s.quarters[0].pat, pat_qoq: pQoQ,
          mcap: s.mcap, pe: s.pe, price: s.price, avg_val: s.avg_val
        });
        log.push(raw.symbol + ' rev=' + rQoQ + '% pat=' + pQoQ + '%');
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
