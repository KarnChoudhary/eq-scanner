// earnings.js v5
// Moneycontrol API 404 — extract from 58 JSON blobs in working HTML page instead
// Screener quarterly parsing fixed in _utils v5

const { fetchDirect, fetchScreenerHTML, parseScreener, sleep, sendError, sendOk } = require('./_utils');

let cache = null, cacheAt = 0;
const TTL = 20 * 60 * 1000;

function within30d(ds) {
  if (!ds) return false;
  try { const d = new Date(ds); const diff = Date.now()-d.getTime(); return !isNaN(d)&&diff>=0&&diff<=30*86400000; }
  catch { return false; }
}
function qoq(c, p) {
  if (c==null||p==null||p===0) return null;
  return Math.round(((c-p)/Math.abs(p))*1000)/10;
}

// ── Source 1: Moneycontrol HTML — extract from 58 JSON blobs ─────────
async function fromMoneycontrol(log) {
  const syms = [];
  try {
    const html = await fetchDirect(
      'https://www.moneycontrol.com/markets/earnings/results-calendar/',
      false, { 'Referer': 'https://www.moneycontrol.com/' }
    );
    log.push('MC HTML: ' + html.length + ' chars');

    // The page has 58 JSON blobs — parse all of them for NSE symbols
    // Extract ALL JSON objects from script tags
    const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    const seen = new Set();
    let sm;
    const today = new Date().toISOString().slice(0,10);

    while ((sm = scriptRe.exec(html)) !== null) {
      const scriptContent = sm[1];
      // Look for patterns with NSE symbol data
      const symPatterns = [
        /"NSEsymbol"\s*:\s*"([A-Z][A-Z0-9&-]{1,20})"/g,
        /"nse_symbol"\s*:\s*"([A-Z][A-Z0-9&-]{1,20})"/g,
        /"NSE"\s*:\s*"([A-Z][A-Z0-9]{1,20})"/g,
        /"symbol"\s*:\s*"([A-Z][A-Z0-9]{2,20})"\s*,\s*"exchange"\s*:\s*"NSE"/g,
        /"scripCode"\s*:\s*"([A-Z][A-Z0-9]{2,20})"/g,
      ];
      for (const re of symPatterns) {
        let m;
        while ((m = re.exec(scriptContent)) !== null) {
          const sym = m[1].replace(/&amp;/g,'&');
          if (!seen.has(sym) && sym.length>=2) {
            seen.add(sym);
            syms.push({ symbol: sym, result_date: today });
          }
        }
      }
    }

    // Also scan outside script tags
    const htmlPatterns = [
      /data-nse-symbol="([A-Z][A-Z0-9&-]{1,20})"/g,
      /data-exchange="NSE"[^>]*data-symbol="([A-Z][A-Z0-9]{1,20})"/g,
      /\/stocks\/([A-Z][A-Z0-9-]{1,20})-[A-Z]{2}-stocks/g,
    ];
    for (const re of htmlPatterns) {
      let m;
      while ((m = re.exec(html)) !== null) {
        const sym = m[1].replace(/-/g,'').replace(/&amp;/g,'&');
        if (!seen.has(sym) && /^[A-Z][A-Z0-9]{1,20}$/.test(sym)) {
          seen.add(sym); syms.push({ symbol: sym, result_date: today });
        }
      }
    }

    log.push('MC HTML symbols found: ' + syms.length);
  } catch(e) { log.push('MC failed: ' + e.message); }
  return syms;
}

// ── Source 2: Moneycontrol results API (try multiple endpoints) ──────
async function fromMoneycontrolAPI(log) {
  const syms = [];
  const today = new Date().toISOString().slice(0,10);
  const past  = new Date(Date.now()-30*86400000).toISOString().slice(0,10);

  // Try multiple MC API patterns — they change frequently
  const endpoints = [
    `https://api.moneycontrol.com/mcapi/v1/results/calendar?startDate=${past}&endDate=${today}&type=Q&exchange=NSE`,
    `https://www.moneycontrol.com/mccode/common/autosuggestion/getResultCalendarData.php?dateFrom=${past}&dateTo=${today}`,
    `https://www.moneycontrol.com/mc/results/calendar/getResultsCalendarData.php?startDate=${past}&endDate=${today}`,
    `https://priceapi.moneycontrol.com/pricefeed/nse/equitycash/results?period=quarterly`,
    `https://api.moneycontrol.com/mcapi/v1/corporate/results?exchange=NSE&period=quarterly&dateFrom=${past}&dateTo=${today}`,
  ];

  for (const url of endpoints) {
    try {
      const data = await fetchDirect(url, true, {
        'Referer': 'https://www.moneycontrol.com/',
        'Origin': 'https://www.moneycontrol.com',
        'X-Requested-With': 'XMLHttpRequest'
      });
      const rows = data?.data || data?.results || data?.items || data?.records || (Array.isArray(data)?data:[]);
      if (rows.length > 0) {
        for (const r of rows) {
          const sym = (r.NSESymbol||r.nse_symbol||r.NSEsymbol||r.symbol||r.sc_id||'').trim().toUpperCase();
          const dt  = r.result_date||r.date||r.ResultDate||today;
          if (sym&&sym.length>1) syms.push({ symbol: sym, result_date: dt.slice(0,10) });
        }
        log.push('MC API ' + url.split('/').pop().split('?')[0] + ': ' + syms.length + ' symbols');
        if (syms.length>0) break;
      }
    } catch(e) { log.push('MC API failed: ' + url.split('/').pop().split('?')[0] + ': ' + e.message); }
  }
  return syms;
}

// ── Source 3: Guaranteed result-season list ──────────────────────────
function resultSeasonList(log) {
  const symbols = [
    'RELIANCE','TCS','HDFCBANK','ICICIBANK','INFOSYS','SBIN','HINDUNILVR','ITC','LT',
    'KOTAKBANK','AXISBANK','WIPRO','HCLTECH','MARUTI','SUNPHARMA','TATAMOTORS',
    'BAJFINANCE','NTPC','NESTLEIND','TECHM','BAJAJFINSV','ONGC','JSWSTEEL','TATASTEEL',
    'M&M','DRREDDY','CIPLA','EICHERMOT','COALINDIA','DIVISLAB','GRASIM','BPCL',
    'HINDALCO','APOLLOHOSP','TATACONSUM','HEROMOTOCO','BRITANNIA','SHRIRAMFIN',
    'TITAN','BAJAJ-AUTO','INDUSINDBK','ZOMATO','DMART','PIDILITIND','SIEMENS',
    'HAVELLS','GODREJCP','DABUR','MARICO','CHOLAFIN','PFC','RECLTD','HAL','BEL',
    'CANBK','BANKBARODA','PNB','HDFCLIFE','SBILIFE','IRCTC','TATAPOWER','ADANIENT',
  ];
  const today = new Date().toISOString().slice(0,10);
  log.push('Result season fallback: ' + symbols.length + ' stocks');
  return symbols.map(s => ({ symbol: s, result_date: today }));
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const revThresh = parseFloat(req.query.rev_thresh)||20;
  const patThresh = parseFloat(req.query.pat_thresh)||20;
  const mcapMin   = parseFloat(req.query.mcap_min)||1000;
  const mcapMax   = parseFloat(req.query.mcap_max)||50000;
  const priceMin  = parseFloat(req.query.price_min)||20;
  const peMax     = parseFloat(req.query.pe_max)||35;
  const valMin    = parseFloat(req.query.val_min)||5;

  if (cache && Date.now()-cacheAt < TTL) {
    const f = applyF(cache,{revThresh,patThresh,mcapMin,mcapMax,priceMin,peMax,valMin});
    return sendOk(res,{count:f.length,stocks:f,cached:true});
  }

  const log = [];
  try {
    const [r1,r2] = await Promise.all([fromMoneycontrol(log), fromMoneycontrolAPI(log)]);

    const symMap = new Map();
    for (const s of [...r1,...r2]) { if(!symMap.has(s.symbol)) symMap.set(s.symbol,s); }

    if (symMap.size < 15) {
      log.push('Supplementing with result season list');
      for (const s of resultSeasonList(log)) { if(!symMap.has(s.symbol)) symMap.set(s.symbol,s); }
    }
    log.push('Total symbols: ' + symMap.size);

    const syms = [...symMap.values()];
    const enriched = [];
    const BATCH = 4;

    for (let i = 0; i < Math.min(syms.length,80); i += BATCH) {
      const batch = syms.slice(i,i+BATCH);
      const results = await Promise.allSettled(batch.map(s => fetchScreenerHTML(s.symbol)));
      for (let j = 0; j < batch.length; j++) {
        const raw = batch[j], r = results[j];
        if (r.status!=='fulfilled'||!r.value) { log.push(raw.symbol+': fetch fail'); continue; }
        const s = parseScreener(r.value);
        if (!s.quarters||s.quarters.length<2) { log.push(raw.symbol+': q='+( s.quarters?.length||0)); continue; }
        const rQoQ = qoq(s.quarters[0].revenue, s.quarters[1].revenue);
        const pQoQ = qoq(s.quarters[0].pat,     s.quarters[1].pat);
        if (rQoQ===null||pQoQ===null) { log.push(raw.symbol+': null qoq'); continue; }
        enriched.push({
          symbol:raw.symbol, name:raw.symbol, sector:s.sector||'N/A',
          result_date:raw.result_date,
          revenue:s.quarters[0].revenue, rev_qoq:rQoQ,
          pat:s.quarters[0].pat, pat_qoq:pQoQ,
          mcap:s.mcap, pe:s.pe, price:s.price, avg_val:s.avg_val
        });
        log.push(raw.symbol+' rev='+rQoQ+'% pat='+pQoQ+'%');
      }
      if (i+BATCH < syms.length) await sleep(300);
    }

    cache = enriched; cacheAt = Date.now();
    const filtered = applyF(enriched,{revThresh,patThresh,mcapMin,mcapMax,priceMin,peMax,valMin});
    return sendOk(res,{count:filtered.length,stocks:filtered,diag:log});
  } catch(e) {
    return sendError(res,500,'Earnings failed: '+e.message);
  }
};

function applyF(stocks,f) {
  return stocks.filter(s=>{
    if(s.rev_qoq<f.revThresh)return false;
    if(s.pat_qoq<f.patThresh)return false;
    if(s.mcap!=null&&s.mcap<f.mcapMin)return false;
    if(s.mcap!=null&&s.mcap>f.mcapMax)return false;
    if(s.price!=null&&s.price<f.priceMin)return false;
    if(s.pe!=null&&s.pe>f.peMax)return false;
    if(s.avg_val!=null&&s.avg_val<f.valMin)return false;
    return true;
  }).sort((a,b)=>b.pat_qoq-a.pat_qoq);
}
