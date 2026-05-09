// api/ipo.js v3
// NSE blocked directly. Strategy:
// 1. NSE new listings via allorigins proxy
// 2. BSE IPO data (public API, less blocked)
// 3. Screener.in recently listed
// 4. Build from Yahoo Finance listing date metadata

const { fetchViaProxy, fetchDirect, fetchScreenerHTML, parseScreenerData, sleep, sendError, sendOk } = require('./_utils');

let cache = null, cacheAt = 0;
const TTL = 60 * 60 * 1000;

function within12m(ds) {
  if (!ds) return false;
  try { const d = new Date(ds); const c = new Date(); c.setFullYear(c.getFullYear()-1); return !isNaN(d) && d >= c && d <= new Date(); }
  catch { return false; }
}
function daysBetween(ds) {
  try { return Math.floor((Date.now() - new Date(ds).getTime()) / 86400000); }
  catch { return null; }
}
function parseAnyDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{2}-\w{3}-\d{4}$/.test(s)) {
    const [d,m,y] = s.split('-');
    const mn = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
    return `${y}-${mn[m]||'01'}-${d.padStart(2,'0')}`;
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) { const [d,m,y] = s.split('/'); return `${y}-${m}-${d}`; }
  if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  try { const d = new Date(s); if (!isNaN(d)) return d.toISOString().slice(0,10); } catch {}
  return null;
}

// NSE via proxy
async function fromNSEProxy(log) {
  const endpoints = [
    'https://www.nseindia.com/api/market-data-pre-open?key=NEWLISTING&type=EQ',
    'https://www.nseindia.com/api/ipo-detail',
    'https://www.nseindia.com/api/equity-stockIndices?index=NEWLY%20LISTED',
  ];
  for (const url of endpoints) {
    try {
      const data = await fetchViaProxy(url, true);
      log.push(url.split('?')[0].split('/').pop() + ' keys: ' + Object.keys(data||{}).slice(0,5).join(','));
      let candidates = Array.isArray(data) ? data : (data?.data || data?.ipoDetails || []);
      if (!candidates.length) {
        for (const k of Object.keys(data||{})) {
          const v = data[k];
          if (Array.isArray(v) && v.length > 0) { candidates = v; break; }
        }
      }
      const withDates = candidates.filter(c => {
        const df = c.listingDate||c.listingDt||c.listing_date||c.listDate||c.LIST_DATE||c.LISTING_DATE;
        return df && within12m(parseAnyDate(df));
      });
      log.push('NSE ' + url.split('?')[1] + ': ' + withDates.length + ' within 12m');
      if (withDates.length > 0) return withDates.map(c => {
        const df = c.listingDate||c.listingDt||c.listing_date||c.listDate||c.LIST_DATE||c.LISTING_DATE;
        return {
          symbol: (c.symbol||c.Symbol||c.SYMBOL||'').trim().toUpperCase(),
          name: c.companyName||c.company||c.COMPANY_NAME||'',
          list_date: parseAnyDate(df),
          issue_price: parseFloat(c.issuePrice||c.cutOffPrice||c.ISSUE_PRICE||0)||null,
          price: parseFloat(c.ltp||c.lastPrice||c.LTP||0)||null,
        };
      }).filter(c => c.symbol);
    } catch (e) { log.push('NSE proxy ' + e.message); }
  }
  return [];
}

// BSE IPO data — less blocked than NSE
async function fromBSE(log) {
  const syms = [];
  try {
    const today = new Date().toISOString().slice(0,10).replace(/-/g,'');
    const past  = new Date(Date.now()-365*86400000).toISOString().slice(0,10).replace(/-/g,'');
    const url = `https://api.bseindia.com/BseIndiaAPI/api/IPODetails/w?strDate=${past}&endDate=${today}&status=listed`;
    const data = await fetchDirect(url, true, { 'Referer': 'https://www.bseindia.com/' });
    const rows = data?.Table || data?.data || data || [];
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const sym = (r.NSESymbol||r.nse_symbol||r.NSE_SYMBOL||'').trim().toUpperCase();
        if (!sym) continue;
        const df = r.ListingDate||r.listing_date||r.LISTING_DATE||r.IssueOpenDate||'';
        const ld = parseAnyDate(df);
        if (!within12m(ld)) continue;
        syms.push({
          symbol: sym,
          name: r.CompanyName||r.company_name||sym,
          list_date: ld,
          issue_price: parseFloat(r.IssuePrice||r.issue_price||0)||null,
          price: parseFloat(r.LastPrice||r.last_price||0)||null,
        });
      }
    }
    log.push('BSE IPO: ' + syms.length);
  } catch (e) { log.push('BSE IPO failed: ' + e.message); }
  return syms;
}

// Screener recently listed
async function fromScreener(log) {
  const syms = [];
  try {
    const html = await fetchDirect('https://www.screener.in/screens/recently-listed/', false,
      { 'Referer': 'https://www.screener.in/' });
    const re = /href="\/company\/([A-Z][A-Z0-9&-]{1,20})\/(?:consolidated\/)?"/gi;
    const seen = new Set(); let m;
    while ((m = re.exec(html)) !== null) {
      const sym = m[1].replace('&amp;','&');
      if (!seen.has(sym) && sym !== 'LOGIN') { seen.add(sym); syms.push({ symbol: sym, name: sym, list_date: null, issue_price: null, price: null }); }
    }
    log.push('Screener recently listed: ' + syms.length);
  } catch (e) { log.push('Screener recently-listed failed: ' + e.message); }
  return syms;
}

async function enrichOne(raw, log) {
  const result = await fetchScreenerHTML(raw.symbol);
  const sc = result ? parseScreenerData(result.html) : null;

  // Get listing date from Screener if not already known
  let listDate = raw.list_date;
  if (!listDate && result?.html) {
    const ldPatterns = [
      /Listed\s*(?:Date)?\s*<\/[^>]+>\s*<[^>]+>\s*([A-Za-z]+\s+\d{4})/i,
      /Listing\s+Date[^<]*<\/[^>]+>\s*<[^>]+>\s*([\d\-\/]+)/i,
      /"listingDate"\s*:\s*"([^"]+)"/i,
    ];
    for (const p of ldPatterns) {
      const m = result.html.match(p);
      if (m) { listDate = parseAnyDate(m[1]); break; }
    }
  }

  const price = sc?.price || raw.price;
  const issuePrice = raw.issue_price;

  return {
    symbol: raw.symbol,
    name: raw.name || raw.symbol,
    sector: sc?.sector || 'N/A',
    list_date: listDate || null,
    days_listed: listDate ? daysBetween(listDate) : null,
    issue_price: issuePrice,
    price: price,
    listing_return: issuePrice && price ? Math.round(((price-issuePrice)/issuePrice)*1000)/10 : null,
    mcap: sc?.mcap || null,
    pe: sc?.pe || null,
    avg_val: sc?.avg_val || null
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const priceMin = parseFloat(req.query.price_min) || 20;
  const valMin   = parseFloat(req.query.val_min)   || 5;
  const MCAP_MIN = 500;

  if (cache && Date.now() - cacheAt < TTL) {
    const f = applyF(cache, { priceMin, valMin, MCAP_MIN });
    return sendOk(res, { count: f.length, stocks: f, cached: true });
  }

  const log = [];
  try {
    // Try all sources
    let listings = await fromNSEProxy(log);
    if (!listings.length) listings = await fromBSE(log);
    if (!listings.length) listings = await fromScreener(log);

    log.push('Raw listings: ' + listings.length);
    if (!listings.length) {
      return sendOk(res, { count: 0, stocks: [], note: 'No IPO listing data available from any source right now.', diag: log });
    }

    // Enrich with Screener
    const enriched = [];
    const BATCH = 4;
    for (let i = 0; i < listings.length; i += BATCH) {
      const batch = listings.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(r => enrichOne(r, log)));
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const s = r.value;
        if (s.list_date && !within12m(s.list_date)) continue;
        enriched.push(s);
      }
      if (i + BATCH < listings.length) await sleep(300);
    }

    cache = enriched; cacheAt = Date.now();
    const filtered = applyF(enriched, { priceMin, valMin, MCAP_MIN });
    return sendOk(res, { count: filtered.length, stocks: filtered, diag: log });
  } catch (e) {
    return sendError(res, 500, 'IPO failed: ' + e.message);
  }
};

function applyF(stocks, { priceMin, valMin, MCAP_MIN }) {
  return stocks.filter(s => {
    if (s.mcap != null && s.mcap < MCAP_MIN) return false;
    if (s.price != null && s.price < priceMin) return false;
    if (s.avg_val != null && s.avg_val < valMin) return false;
    return true;
  }).sort((a, b) => (a.days_listed||999) - (b.days_listed||999));
}
