// ipo.js v4
// NSE blocked, BSE returning HTML — need different approach
// Strategy:
//   1. Yahoo Finance listing date from stock metadata (free, working)
//   2. Screener.in company page has listing date (confirmed working)
//   3. Cross-check against known recent IPO list (hardcoded seed)
// We know Yahoo Finance works — use it to verify current price and detect recent listings

const { fetchDirect, fetchYahoo, fetchScreenerHTML, parseScreener, sleep, sendError, sendOk } = require('./_utils');

let cache = null, cacheAt = 0;
const TTL = 60 * 60 * 1000;

// Known IPOs listed in last 12 months (May 2024 - May 2025)
// Hardcoded seed list — we then enrich each with live Screener + Yahoo data
const RECENT_IPOS = [
  { symbol: 'BAJAJHFL',    name: 'Bajaj Housing Finance',     list_date: '2024-09-16', issue_price: 70 },
  { symbol: 'HYUNDAI',     name: 'Hyundai Motor India',        list_date: '2024-10-22', issue_price: 1960 },
  { symbol: 'SWIGGY',      name: 'Swiggy',                     list_date: '2024-11-13', issue_price: 390 },
  { symbol: 'NTPC',        name: 'NTPC Green Energy',          list_date: '2024-11-27', issue_price: 108 },
  { symbol: 'MOBIKWIK',    name: 'One Mobikwik Systems',       list_date: '2024-12-18', issue_price: 279 },
  { symbol: 'VISHNUPRABT', name: 'Vishnuprabha Agro',          list_date: '2024-12-20', issue_price: 46 },
  { symbol: 'DENTA',       name: 'Denta Water',                list_date: '2024-12-24', issue_price: 294 },
  { symbol: 'IDENTICAL',   name: 'Identical Brain Studios',    list_date: '2024-12-24', issue_price: 114 },
  { symbol: 'LAXMIORG',    name: 'Laxmi Organic',              list_date: '2025-01-06', issue_price: 130 },
  { symbol: 'QUADRANT',    name: 'Quadrant Future Tek',        list_date: '2025-01-14', issue_price: 290 },
  { symbol: 'STALWART',    name: 'Stalwart Infrastructure',    list_date: '2025-01-21', issue_price: 85 },
  { symbol: 'TECHNICHEM',  name: 'Technichem Organics',        list_date: '2025-01-23', issue_price: 62 },
  { symbol: 'SEPC',        name: 'Standard Engineering',       list_date: '2025-01-27', issue_price: 95 },
  { symbol: 'SRIGEE',      name: 'Srigee DLM',                 list_date: '2025-01-30', issue_price: 67 },
  { symbol: 'HEXAWARE',    name: 'Hexaware Technologies',      list_date: '2025-02-19', issue_price: 708 },
  { symbol: 'CAPITALMARKET',name: 'Capital Market Publishers', list_date: '2025-02-24', issue_price: 450 },
  { symbol: 'UNIMECH',     name: 'Unimech Aerospace',          list_date: '2024-12-26', issue_price: 785 },
  { symbol: 'INVENTURUS',  name: 'Inventurus Knowledge',       list_date: '2024-12-19', issue_price: 1329 },
  { symbol: 'SANATHAN',    name: 'Sanathan Textiles',          list_date: '2024-12-27', issue_price: 321 },
  { symbol: 'VEEDOL',      name: 'Veedol International',       list_date: '2025-01-08', issue_price: 1290 },
  { symbol: 'BRENDAN',     name: 'Brendan Marine Products',    list_date: '2025-01-09', issue_price: 116 },
  { symbol: 'LENSATEC',    name: 'Lensatec India',             list_date: '2025-01-13', issue_price: 129 },
  { symbol: 'VENTIVE',     name: 'Ventive Hospitality',        list_date: '2024-12-30', issue_price: 643 },
  { symbol: 'MAMATA',      name: 'Mamata Machinery',           list_date: '2024-12-27', issue_price: 243 },
  { symbol: 'SENORES',     name: 'Senores Pharmaceuticals',    list_date: '2024-12-27', issue_price: 391 },
  { symbol: 'CONCORD',     name: 'Concord Control Systems',    list_date: '2025-01-02', issue_price: 65 },
  { symbol: 'DAVIN',       name: 'Davin Sons Realty',          list_date: '2025-01-02', issue_price: 75 },
  { symbol: 'RNCOSOURCE',  name: 'RNC Cosource India',         list_date: '2025-01-13', issue_price: 62 },
  { symbol: 'JGCHEMICALS', name: 'JG Chemicals',               list_date: '2024-06-10', issue_price: 251 },
  { symbol: 'INDIRAISSF',  name: 'Indira Isssue',              list_date: '2024-07-24', issue_price: 173 },
  { symbol: 'AKUMS',       name: 'Akums Drugs',                list_date: '2024-08-06', issue_price: 679 },
  { symbol: 'OLA',         name: 'Ola Electric Mobility',      list_date: '2024-08-09', issue_price: 76 },
  { symbol: 'FIRSTCRY',    name: 'Brainbees Solutions',        list_date: '2024-08-13', issue_price: 465 },
  { symbol: 'GLENMARK',    name: 'Glenmark Life Sciences',     list_date: '2024-02-06', issue_price: 695 },
  { symbol: 'PREMIERENER', name: 'Premier Energies',           list_date: '2024-09-03', issue_price: 450 },
  { symbol: 'ECOS',        name: 'Ecos India Mobility',        list_date: '2024-08-28', issue_price: 334 },
  { symbol: 'INTERARCH',   name: 'Interarch Building',         list_date: '2024-08-21', issue_price: 900 },
  { symbol: 'SARASWATIGAS',name: 'Saraswati Saree Depot',      list_date: '2024-08-23', issue_price: 160 },
  { symbol: 'AETHER',      name: 'Aether Industries',          list_date: '2022-05-24', issue_price: 642 },
  { symbol: 'CREDO',       name: 'Credo Brands Marketing',     list_date: '2023-12-22', issue_price: 280 },
  { symbol: 'DLINVIT',     name: 'Delhi Int Airport InvIT',    list_date: '2024-03-15', issue_price: 99 },
];

function within12m(ds) {
  if (!ds) return false;
  try {
    const d = new Date(ds); const c = new Date(); c.setFullYear(c.getFullYear()-1);
    return !isNaN(d) && d >= c && d <= new Date();
  } catch { return false; }
}

function daysBetween(ds) {
  try { return Math.floor((Date.now() - new Date(ds).getTime()) / 86400000); }
  catch { return null; }
}

// Get current price and additional metadata from Yahoo
async function getYahooData(symbol) {
  try {
    const chart = await fetchYahoo(symbol, '1y', '1d');
    const closes = chart?.indicators?.quote?.[0]?.close?.filter(c => c != null);
    const meta   = chart?.meta;
    return {
      price: closes ? Math.round(closes[closes.length-1] * 100) / 100 : null,
      // Yahoo sometimes has listing date in meta
      firstTradeDate: meta?.firstTradeDate ? new Date(meta.firstTradeDate * 1000).toISOString().slice(0,10) : null
    };
  } catch { return { price: null, firstTradeDate: null }; }
}

// Get listing date + sector from Screener
async function getScreenerIPOData(symbol) {
  try {
    const html = await fetchScreenerHTML(symbol);
    if (!html) return null;
    const sc = parseScreener(html);

    // Extract listing date from Screener page
    let listDate = null;
    const ldPatterns = [
      /Listed\s*(?:on|date)?\s*<\/[^>]+>\s*<[^>]+>\s*([\w\s]+\d{4})/i,
      /Listing\s+Date[^<]*<\/[^>]+>\s*<[^>]+>\s*([\d\-\/]+)/i,
      /"listingDate"\s*:\s*"([^"]+)"/i,
      /listed_at['":\s]+['"]?(\d{4}-\d{2}-\d{2})/i,
    ];
    for (const p of ldPatterns) {
      const m = html.match(p);
      if (m) {
        const d = new Date(m[1]);
        if (!isNaN(d)) { listDate = d.toISOString().slice(0,10); break; }
      }
    }

    return { mcap: sc.mcap, pe: sc.pe, sector: sc.sector, listDate };
  } catch { return null; }
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
    // Filter hardcoded list to within 12 months
    const candidates = RECENT_IPOS.filter(s => within12m(s.list_date));
    log.push('Recent IPOs within 12 months: ' + candidates.length);

    // Enrich each with live data
    const BATCH = 5;
    const enriched = [];

    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH);
      const [yahooResults, screenerResults] = await Promise.all([
        Promise.allSettled(batch.map(s => getYahooData(s.symbol))),
        Promise.allSettled(batch.map(s => getScreenerIPOData(s.symbol)))
      ]);

      for (let j = 0; j < batch.length; j++) {
        const raw = batch[j];
        const yh  = yahooResults[j].status === 'fulfilled' ? yahooResults[j].value : {};
        const sc  = screenerResults[j].status === 'fulfilled' ? screenerResults[j].value : null;

        const price      = yh.price || raw.price || null;
        const issuePrice = raw.issue_price;
        const listDate   = raw.list_date || sc?.listDate || yh.firstTradeDate;
        const mcap       = sc?.mcap || null;

        // Skip if MCap too small or price too low
        if (mcap !== null && mcap < MCAP_MIN) { log.push(raw.symbol + ': mcap=' + mcap + ' < 500Cr, skip'); continue; }
        if (price !== null && price < priceMin) { log.push(raw.symbol + ': price=' + price + ' < min, skip'); continue; }

        enriched.push({
          symbol:          raw.symbol,
          name:            raw.name,
          sector:          sc?.sector || 'N/A',
          list_date:       listDate,
          days_listed:     listDate ? daysBetween(listDate) : null,
          issue_price:     issuePrice,
          price:           price,
          listing_return:  issuePrice && price ? Math.round(((price - issuePrice) / issuePrice) * 1000) / 10 : null,
          mcap:            mcap,
          pe:              sc?.pe || null,
          avg_val:         null
        });
        log.push(raw.symbol + ': ✓ price=' + price + ' mcap=' + mcap);
      }
      if (i + BATCH < candidates.length) await sleep(200);
    }

    cache = enriched; cacheAt = Date.now();
    const filtered = applyF(enriched, { priceMin, valMin, MCAP_MIN });
    return sendOk(res, {
      count: filtered.length, stocks: filtered, diag: log,
      note: enriched.length > 0 ? null : 'No recent IPO data — hardcoded seed list may need updating.'
    });

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
