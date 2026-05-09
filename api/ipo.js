// api/ipo.js v2 — multiple NSE endpoints + Screener fallback
const { sendError, sendOk, sleep } = require('./_utils');

let cache = null, cacheAt = 0;
const TTL = 60 * 60 * 1000;

let _ck='', _ckat=0;
async function nCk(){
  if(_ck && Date.now()-_ckat < 8*60000) return _ck;
  try {
    const r = await fetch('https://www.nseindia.com', {
      headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept':'text/html'}
    });
    const sc = r.headers.get('set-cookie')||'';
    _ck = sc.split(',').map(c=>c.split(';')[0].trim()).filter(c=>c.includes('=')).join('; ');
    _ckat = Date.now();
  } catch {}
  return _ck;
}

const NSE_HDR = (ck) => ({
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':'application/json, text/plain, */*',
  'Accept-Language':'en-US,en;q=0.9',
  'Referer':'https://www.nseindia.com/',
  'Cookie': ck
});

function within12m(ds) {
  if (!ds) return false;
  try {
    const d = new Date(ds);
    if (isNaN(d)) return false;
    const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 1);
    return d >= cutoff && d <= new Date();
  } catch { return false; }
}

function daysBetween(ds) {
  try { return Math.floor((Date.now() - new Date(ds).getTime()) / 86400000); }
  catch { return null; }
}

// Parse listing date from various NSE date formats
function parseDate(val) {
  if (!val) return null;
  // formats: "13-Nov-2024", "2024-11-13", "13/11/2024"
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{2}-\w{3}-\d{4}$/.test(s)) {
    const [d,m,y] = s.split('-');
    const months = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
    return `${y}-${months[m]||'01'}-${d.padStart(2,'0')}`;
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [d,m,y] = s.split('/'); return `${y}-${m}-${d}`;
  }
  // Try native parse as last resort
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().split('T')[0];
  return null;
}

async function tryNSEEndpoints(log) {
  const ck = await nCk();
  const endpoints = [
    '/api/market-data-pre-open?key=NEWLISTING&type=EQ',
    '/api/ipo-detail',
    '/api/equity-stockIndices?index=NEWLY%20LISTED',
    '/api/allIndices',  // sometimes has newly listed section
  ];

  for (const ep of endpoints) {
    try {
      const r = await fetch('https://www.nseindia.com' + ep, { headers: NSE_HDR(ck) });
      if (!r.ok) { log.push(ep + ' → HTTP ' + r.status); continue; }
      const data = await r.json();
      log.push(ep + ' → keys: ' + Object.keys(data).slice(0,6).join(','));

      let candidates = [];
      if (Array.isArray(data)) candidates = data;
      else if (Array.isArray(data.data)) candidates = data.data;
      else if (Array.isArray(data.ipoDetails)) candidates = data.ipoDetails;
      else {
        for (const k of Object.keys(data)) {
          if (Array.isArray(data[k]) && data[k].length > 0) { candidates = data[k]; break; }
        }
      }

      log.push(ep + ' → candidates: ' + candidates.length);

      // Check if these look like listing records
      const withDates = candidates.filter(c => {
        const dateVal = c.listingDate || c.listingDt || c.listing_date
          || c.listDate || c.ipoOpenDate || c.LIST_DATE || c.LISTING_DATE;
        return dateVal && within12m(parseDate(dateVal));
      });

      if (withDates.length > 0) {
        log.push(ep + ' → within 12m: ' + withDates.length);
        return withDates.map(c => {
          const rawDate = c.listingDate || c.listingDt || c.listing_date
            || c.listDate || c.ipoOpenDate || c.LIST_DATE || c.LISTING_DATE;
          return {
            symbol: (c.symbol || c.Symbol || c.SYMBOL || '').trim().toUpperCase(),
            name: c.companyName || c.company || c.COMPANY_NAME || '',
            list_date: parseDate(rawDate),
            issue_price: parseFloat(c.issuePrice || c.cutOffPrice || c.ISSUE_PRICE || 0) || null,
            price: parseFloat(c.ltp || c.lastPrice || c.LTP || c.LAST || 0) || null,
          };
        }).filter(c => c.symbol);
      }
    } catch (e) { log.push(ep + ' → error: ' + e.message); }
  }
  return [];
}

// Fallback: scrape NSE new listings page HTML
async function scrapeNSENewListings(log) {
  try {
    const ck = await nCk();
    const r = await fetch('https://www.nseindia.com/market-data/new-listings-equity-market', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Referer': 'https://www.nseindia.com/',
        'Cookie': ck
      }
    });
    if (!r.ok) throw new Error('HTML page HTTP ' + r.status);
    const html = await r.text();
    // Extract from embedded JSON or table
    const jsonM = html.match(/var\s+listingData\s*=\s*(\[[\s\S]*?\]);/);
    if (jsonM) {
      const arr = JSON.parse(jsonM[1]);
      log.push('NSE new listings HTML: ' + arr.length + ' rows');
      return arr.filter(c => within12m(parseDate(c.listingDate || c.date))).map(c => ({
        symbol: (c.symbol||'').toUpperCase(),
        name: c.companyName || c.company || '',
        list_date: parseDate(c.listingDate || c.date),
        issue_price: parseFloat(c.issuePrice || 0) || null,
        price: parseFloat(c.ltp || c.lastPrice || 0) || null
      })).filter(c => c.symbol);
    }
    log.push('NSE HTML: no listingData var found');
    return [];
  } catch (e) { log.push('NSE HTML scrape failed: ' + e.message); return []; }
}

// Screener new listings search
async function screenerNewListings(log) {
  try {
    // Screener has a "recently listed" screen
    const r = await fetch('https://www.screener.in/screens/recently-listed/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html', 'Referer': 'https://www.screener.in/' }
    });
    if (!r.ok) throw new Error('Screener recently-listed HTTP ' + r.status);
    const html = await r.text();
    // Parse symbol links
    const re = /href="\/company\/([A-Z0-9]+)\/"/gi;
    const syms = new Set(); let m;
    while ((m = re.exec(html)) !== null) syms.add(m[1]);
    log.push('Screener recently-listed: ' + syms.size + ' symbols');
    return [...syms].map(s => ({ symbol: s, name: s, list_date: null, issue_price: null, price: null }));
  } catch (e) { log.push('Screener recently-listed failed: ' + e.message); return []; }
}

async function enrichScreener(symbol, log) {
  const urls = [
    `https://www.screener.in/company/${symbol}/consolidated/`,
    `https://www.screener.in/company/${symbol}/`
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html', 'Referer': 'https://www.screener.in/' }
      });
      if (!r.ok) continue;
      const html = await r.text();
      const out = { mcap: null, pe: null, price: null, sector: 'N/A', list_date: null };
      const prM = html.match(/id="current-price"[^>]*>\s*([\d,]+(?:\.\d+)?)/i);
      if (prM) out.price = parseFloat(prM[1].replace(/,/g,''));
      const mcM = html.match(/Market Cap[^<]*<\/[^>]+>\s*<[^>]+>\s*₹?\s*([\d,]+(?:\.\d+)?)/i);
      if (mcM) out.mcap = parseFloat(mcM[1].replace(/,/g,''));
      const peM = html.match(/Stock P\/E[^<]*<\/[^>]+>\s*<[^>]+>\s*([\d.]+)/i);
      if (peM) out.pe = parseFloat(peM[1]);
      const jldM = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i);
      if (jldM) { try { const jd=JSON.parse(jldM[1]); out.sector=jd.industry||jd.sector||'N/A'; } catch {} }
      // Listed date from Screener "Company Overview" or date fields
      const ldM = html.match(/Listed\s*<\/[^>]+>\s*<[^>]+>\s*([A-Z][a-z]+\s+\d{4})/i)
        || html.match(/Listing\s+Date[^<]*<\/[^>]+>\s*<[^>]+>\s*([\d\-\/]+)/i);
      if (ldM) out.list_date = parseDate(ldM[1]);
      return out;
    } catch { continue; }
  }
  return null;
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
    let listings = await tryNSEEndpoints(log);
    if (!listings.length) listings = await scrapeNSENewListings(log);
    if (!listings.length) listings = await screenerNewListings(log);

    log.push('Total listings found: ' + listings.length);

    if (!listings.length) {
      return sendOk(res, { count: 0, stocks: [], note: 'No IPO/new listing data found from any source.', diag: log });
    }

    // Enrich with Screener
    const BATCH = 5;
    const enriched = [];
    for (let i = 0; i < listings.length; i += BATCH) {
      const batch = listings.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(s => enrichScreener(s.symbol, log)));
      for (let j = 0; j < batch.length; j++) {
        const raw = batch[j];
        const r = results[j];
        const sc = r.status === 'fulfilled' ? r.value : null;
        const listDate = raw.list_date || sc?.list_date;
        if (listDate && !within12m(listDate)) { log.push(raw.symbol + ': outside 12m'); continue; }
        const price = sc?.price || raw.price;
        const issuePrice = raw.issue_price;
        enriched.push({
          symbol: raw.symbol,
          name: raw.name || raw.symbol,
          sector: sc?.sector || 'N/A',
          list_date: listDate || '—',
          days_listed: listDate ? daysBetween(listDate) : null,
          issue_price: issuePrice,
          price: price,
          listing_return: issuePrice && price ? Math.round(((price-issuePrice)/issuePrice)*1000)/10 : null,
          mcap: sc?.mcap || null,
          pe: sc?.pe || null,
          avg_val: null
        });
      }
      if (i + BATCH < listings.length) await sleep(300);
    }

    cache = enriched; cacheAt = Date.now();
    const filtered = applyF(enriched, { priceMin, valMin, MCAP_MIN });
    return sendOk(res, { count: filtered.length, stocks: filtered, diag: log });
  } catch (e) {
    return sendError(res, 500, 'IPO scan failed: ' + e.message);
  }
};

function applyF(stocks, { priceMin, valMin, MCAP_MIN }) {
  return stocks
    .filter(s => {
      if (s.mcap != null && s.mcap < MCAP_MIN) return false;
      if (s.price != null && s.price < priceMin) return false;
      if (s.avg_val != null && s.avg_val < valMin) return false;
      return true;
    })
    .sort((a, b) => (a.days_listed || 999) - (b.days_listed || 999));
}
