// earnings.js v4
// Working sources: Screener.in (✓), Moneycontrol (✓), Yahoo Finance (✓)
// Dead: NSE direct, allorigins proxy, Trendlyne 404, Screener /screens/latest-results/ 404
// Strategy:
//   Symbol discovery: Moneycontrol results calendar + Screener company search
//   Quarterly data: Screener per-symbol HTML (confirmed working)

const { fetchDirect, fetchScreenerHTML, parseScreener, sleep, sendError, sendOk } = require('./_utils');

let cache = null, cacheAt = 0;
const TTL = 20 * 60 * 1000;

function within30d(ds) {
  if (!ds) return false;
  try {
    const d = new Date(ds);
    const diff = Date.now() - d.getTime();
    return !isNaN(d) && diff >= 0 && diff <= 30 * 86400000;
  } catch { return false; }
}

function qoq(c, p) {
  if (c == null || p == null || p === 0) return null;
  return Math.round(((c - p) / Math.abs(p)) * 1000) / 10;
}

// ── Source 1: Moneycontrol Results Calendar ──────────────────────────
// Confirmed: page loads (172KB), need correct NSE symbol extraction
async function fromMoneycontrol(log) {
  const syms = [];
  try {
    // Moneycontrol results calendar with date range
    const today = new Date();
    const past  = new Date(Date.now() - 30 * 86400000);
    const fmt   = d => d.toISOString().slice(0,10);

    // Try the API endpoint that powers their calendar
    const apiUrls = [
      `https://api.moneycontrol.com/mcapi/v1/results/calendar?startDate=${fmt(past)}&endDate=${fmt(today)}&type=Q&exchange=NSE`,
      `https://www.moneycontrol.com/mc/results/calendar/getResultsCalendarData?startDate=${fmt(past)}&endDate=${fmt(today)}&type=Q`,
      `https://priceapi.moneycontrol.com/pricefeed/nse/equitycash/results?period=quarterly&startDate=${fmt(past)}&endDate=${fmt(today)}`,
    ];

    for (const url of apiUrls) {
      try {
        const data = await fetchDirect(url, true, {
          'Referer': 'https://www.moneycontrol.com/',
          'Origin': 'https://www.moneycontrol.com'
        });
        log.push('MC API ' + url.split('/').slice(-1)[0] + ': ' + JSON.stringify(data).slice(0,120));
        const rows = data?.data || data?.results || data?.items || (Array.isArray(data) ? data : []);
        if (rows.length > 0) {
          for (const r of rows) {
            const sym = (r.NSE_symbol || r.nse_symbol || r.sc_id || r.symbol || '').trim().toUpperCase();
            const dt  = r.result_date || r.date || r.ResultDate || '';
            if (sym && sym.length > 1) syms.push({ symbol: sym, result_date: dt.slice(0,10) || fmt(today) });
          }
          log.push('MC API found: ' + syms.length + ' symbols'); 
          if (syms.length > 0) break;
        }
      } catch (e) { log.push('MC API failed: ' + e.message); }
    }

    // If API failed, parse the HTML page we know loads (172KB)
    if (!syms.length) {
      const html = await fetchDirect(
        'https://www.moneycontrol.com/markets/earnings/results-calendar/',
        false,
        { 'Referer': 'https://www.moneycontrol.com/' }
      );
      log.push('MC HTML size: ' + html.length);

      // Try many patterns to find NSE codes
      const patterns = [
        // JSON embedded in page script tags
        /"NSESymbol"\s*:\s*"([A-Z][A-Z0-9&-]{1,20})"/g,
        /"nseSymbol"\s*:\s*"([A-Z][A-Z0-9&-]{1,20})"/g,
        /"sc_id"\s*:\s*"([A-Z][A-Z0-9&-]{1,20})"/g,
        /data-nse="([A-Z][A-Z0-9&-]{1,20})"/g,
        /data-exchange="NSE"[^>]*data-symbol="([A-Z][A-Z0-9&-]{1,20})"/g,
        /NSE:([A-Z][A-Z0-9]{1,20})\b/g,
        // Script variable assignments
        /symbol\s*[:=]\s*["']([A-Z][A-Z0-9]{2,20})["']/g,
      ];

      const seen = new Set();
      const fmt2 = new Date().toISOString().slice(0,10);
      for (const re of patterns) {
        let m;
        while ((m = re.exec(html)) !== null) {
          const sym = m[1].replace('&amp;','&');
          if (!seen.has(sym) && sym.length >= 2) {
            seen.add(sym);
            syms.push({ symbol: sym, result_date: fmt2 });
          }
        }
      }
      log.push('MC HTML patterns found: ' + syms.length + ' symbols');

      // Extract from embedded JSON blocks
      if (syms.length < 5) {
        const jsonBlocks = html.match(/\{[^{}]{50,2000}\}/g) || [];
        for (const block of jsonBlocks.slice(0, 200)) {
          try {
            const obj = JSON.parse(block);
            const sym = obj.NSESymbol || obj.nseSymbol || obj.sc_id || obj.nse_symbol;
            if (sym && /^[A-Z][A-Z0-9]{1,20}$/.test(sym) && !seen.has(sym)) {
              seen.add(sym);
              syms.push({ symbol: sym, result_date: fmt2 });
            }
          } catch {}
        }
        log.push('MC JSON block extraction: ' + syms.length + ' total symbols');
      }
    }
  } catch (e) { log.push('Moneycontrol failed: ' + e.message); }
  return syms;
}

// ── Source 2: Screener.in search for recent results ──────────────────
// Screener has a screener/screen for companies that recently reported
async function fromScreenerScreens(log) {
  const syms = [];
  try {
    // Screener.in has public screens — "recently announced results"
    const urls = [
      'https://www.screener.in/screen/raw/?sort=result_date&order=-1&query=',
      'https://www.screener.in/screens/annual-reports/',
      'https://www.screener.in/processes/latest-results/',
    ];
    for (const url of urls) {
      try {
        const html = await fetchDirect(url, false, { 'Referer': 'https://www.screener.in/' });
        const re = /href="\/company\/([A-Z][A-Z0-9&-]{1,20})\/(?:consolidated\/)?"/gi;
        const seen = new Set(); let m; let count = 0;
        while ((m = re.exec(html)) !== null && count < 100) {
          const sym = m[1].replace('&amp;','&');
          if (!seen.has(sym) && sym !== 'LOGIN' && sym.length >= 2) {
            seen.add(sym); count++;
            syms.push({ symbol: sym, result_date: new Date().toISOString().slice(0,10) });
          }
        }
        if (syms.length > 0) { log.push('Screener screen ' + url.split('/').slice(-2)[0] + ': ' + syms.length + ' symbols'); break; }
      } catch (e) { log.push('Screener screen failed: ' + url + ' ' + e.message); }
    }
  } catch (e) { log.push('Screener screens outer error: ' + e.message); }
  return syms;
}

// ── Source 3: Screener.in company search by recent quarter ───────────
// Screener search API — find companies with recent results
async function fromScreenerSearch(log) {
  const syms = [];
  try {
    // Screener search API is public
    const queries = ['results', 'quarterly results', 'Q4 results', 'Q3 results'];
    for (const q of queries) {
      try {
        const url = `https://www.screener.in/api/company/search/?q=${encodeURIComponent(q)}&v=3`;
        const data = await fetchDirect(url, true, {
          'Referer': 'https://www.screener.in/',
          'X-Requested-With': 'XMLHttpRequest'
        });
        if (Array.isArray(data) && data.length) {
          for (const item of data.slice(0, 30)) {
            const sym = (item.symbol || item.mc_slug || '').trim().toUpperCase().replace(/-BE$|-SM$/, '');
            if (sym && /^[A-Z][A-Z0-9&-]{1,20}$/.test(sym)) {
              syms.push({ symbol: sym, result_date: new Date().toISOString().slice(0,10) });
            }
          }
          log.push('Screener search "' + q + '": ' + syms.length + ' symbols');
          if (syms.length >= 10) break;
        }
      } catch (e) { log.push('Screener search error: ' + e.message); }
    }
  } catch (e) { log.push('Screener search outer: ' + e.message); }
  return syms;
}

// ── Source 4: Known large-cap quarterly cycle ────────────────────────
// Major index stocks always report results — we know the approximate cycle.
// This ensures Scan 1 always has something to show even if all scraping fails.
// Q4 FY25 results season: April-May 2025. Q1 FY26: July-August 2025.
function getResultSeasonSymbols(log) {
  // Top 60 Nifty50+Next50 stocks — these always report, guaranteed
  const symbols = [
    'RELIANCE','TCS','HDFCBANK','ICICIBANK','INFOSYS','SBIN','HINDUNILVR','ITC','LT',
    'KOTAKBANK','AXISBANK','WIPRO','HCLTECH','ASIANPAINT','MARUTI','SUNPHARMA','TATAMOTORS',
    'BAJFINANCE','NTPC','POWERGRID','NESTLEIND','TECHM','BAJAJFINSV','ONGC','JSWSTEEL',
    'TATASTEEL','DRREDDY','CIPLA','EICHERMOT','COALINDIA','DIVISLAB','GRASIM','BPCL',
    'HINDALCO','VEDL','APOLLOHOSP','TATACONSUM','HEROMOTOCO','BRITANNIA','SHRIRAMFIN',
    'TITAN','BAJAJ-AUTO','INDUSINDBK','TRENT','ZOMATO','DMART','PIDILITIND','SIEMENS',
    'HAVELLS','GODREJCP','DABUR','MARICO','CHOLAFIN','PFC','RECLTD','HAL','BEL',
    'CANBK','BANKBARODA','PNB','HDFCLIFE','SBILIFE','APOLLOTYRE','MRF','IRCTC',
  ];
  const today = new Date().toISOString().slice(0,10);
  log.push('Result season fallback: ' + symbols.length + ' major stocks');
  return symbols.map(s => ({ symbol: s, result_date: today }));
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
    // Try all discovery sources in parallel
    const [r1, r2, r3] = await Promise.all([
      fromMoneycontrol(log),
      fromScreenerScreens(log),
      fromScreenerSearch(log),
    ]);

    // Merge, deduplicate
    const symMap = new Map();
    for (const s of [...r1, ...r2, ...r3]) {
      if (!symMap.has(s.symbol)) symMap.set(s.symbol, s);
    }

    // If discovery found < 20 symbols, supplement with result season list
    if (symMap.size < 20) {
      log.push('Discovery found only ' + symMap.size + ' symbols — adding result season list');
      for (const s of getResultSeasonSymbols(log)) {
        if (!symMap.has(s.symbol)) symMap.set(s.symbol, s);
      }
    }

    log.push('Total unique symbols to check: ' + symMap.size);

    // Fetch Screener quarterly data for each symbol
    const syms = [...symMap.values()];
    const enriched = [];
    const BATCH = 4;

    for (let i = 0; i < Math.min(syms.length, 80); i += BATCH) {
      const batch = syms.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(s => fetchScreenerHTML(s.symbol))
      );

      for (let j = 0; j < batch.length; j++) {
        const raw = batch[j];
        const r   = results[j];
        if (r.status !== 'fulfilled' || !r.value) {
          log.push(raw.symbol + ': fetch failed');
          continue;
        }
        const s = parseScreener(r.value);
        if (!s.quarters || s.quarters.length < 2) {
          log.push(raw.symbol + ': q=' + (s.quarters?.length || 0));
          continue;
        }
        const q0 = s.quarters[0], q1 = s.quarters[1];
        const rQoQ = qoq(q0.revenue, q1.revenue);
        const pQoQ = qoq(q0.pat, q1.pat);
        if (rQoQ === null || pQoQ === null) {
          log.push(raw.symbol + ': null qoq r=' + q0.revenue + '/' + q1.revenue);
          continue;
        }
        enriched.push({
          symbol: raw.symbol,
          name: raw.symbol,
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
