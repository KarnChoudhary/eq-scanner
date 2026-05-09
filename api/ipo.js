// api/ipo.js
// Scan 4: IPO Stocks
// Criteria: Listed on NSE within last 12 months, MCap > 500 Cr
// Global filters: only Min Price and Avg Daily Value apply
// Data: NSE listing data + Screener for fundamentals

const { fetchNSE, sendError, sendOk, sleep } = require('./_utils');

let cache = null;
let cacheAt = 0;
const TTL = 60 * 60 * 1000; // 1 hour

function isWithinMonths(dateStr, months) {
  try {
    const d = new Date(dateStr);
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    return d >= cutoff && d <= new Date();
  } catch {
    return false;
  }
}

function daysBetween(dateStr) {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    return Math.floor((now - d) / (1000 * 60 * 60 * 24));
  } catch {
    return null;
  }
}

async function fetchScreenerIPOData(symbol) {
  const urls = [
    `https://www.screener.in/company/${symbol}/consolidated/`,
    `https://www.screener.in/company/${symbol}/`
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Referer': 'https://www.screener.in/'
        }
      });
      if (!res.ok) continue;
      const html = await res.text();

      const data = { mcap: null, pe: null, price: null, sector: 'N/A', avg_val: null };

      // MCap
      const mcapM = html.match(/Market Cap[^<]*<\/td>[^<]*<td[^>]*>\s*₹?\s*([\d,]+(?:\.\d+)?)\s*Cr/i);
      if (mcapM) data.mcap = parseFloat(mcapM[1].replace(/,/g, ''));

      // Current price
      const prM = html.match(/id="current-price"[^>]*>([\d,]+(?:\.\d+)?)/i);
      if (prM) data.price = parseFloat(prM[1].replace(/,/g, ''));

      // PE
      const peM = html.match(/Stock P\/E[^<]*<\/td>[^<]*<td[^>]*>\s*([\d.]+)/i);
      if (peM) data.pe = parseFloat(peM[1]);

      // Sector
      const secM = html.match(/"sector"\s*:\s*"([^"]+)"/i);
      if (secM) data.sector = secM[1];

      return data;
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchNSEIPOListings() {
  // NSE new listings page
  // Primary source: NSE's listing data available through their public API
  let listings = [];

  try {
    // NSE new listings in capital market segment
    const data = await fetchNSE('/api/market-data-pre-open?key=NEWLISTING&type=EQ');
    if (data && Array.isArray(data.data)) {
      listings = data.data;
    }
  } catch (e) {
    console.warn('NSE new listing API failed:', e.message);
  }

  // Fallback: NSE IPO details endpoint
  if (!listings.length) {
    try {
      const data = await fetchNSE('/api/ipo-detail');
      if (data && Array.isArray(data)) {
        listings = data;
      }
    } catch (e) {
      console.warn('NSE IPO detail API failed:', e.message);
    }
  }

  // Fallback 2: NSE equity market overview which includes recently listed stocks
  if (!listings.length) {
    try {
      const data = await fetchNSE('/api/equity-stockIndices?index=NEWLY%20LISTED');
      if (data && data.data) {
        listings = data.data;
      }
    } catch (e) {
      console.warn('NSE newly listed API failed:', e.message);
    }
  }

  return listings;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const priceMin = parseFloat(req.query.price_min) || 20;
  const valMin = parseFloat(req.query.val_min) || 5;
  // Hard filter for IPO scan
  const MCAP_HARD_MIN = 500;

  if (cache && Date.now() - cacheAt < TTL) {
    const filtered = applyFilters(cache, { priceMin, valMin, MCAP_HARD_MIN });
    return sendOk(res, { count: filtered.length, stocks: filtered, cached: true });
  }

  try {
    const rawListings = await fetchNSEIPOListings();

    // Filter to last 12 months
    // NSE listing data fields vary by endpoint:
    // listingDate | listingDt | listing_date | ipoOpenDate
    const recentIPOs = rawListings.filter(s => {
      const dateField = s.listingDate || s.listingDt || s.listing_date || s.ipoOpenDate || s.listDate;
      return dateField && isWithinMonths(dateField, 12);
    });

    if (!recentIPOs.length) {
      // If NSE APIs returned nothing useful, build from NSE equity list
      // filtered by listing year
      return sendOk(res, {
        count: 0,
        stocks: [],
        note: 'NSE IPO listing data temporarily unavailable. Please try again later.'
      });
    }

    // Enrich with Screener data — MCap, PE, current price, sector
    const BATCH = 5;
    const enriched = [];

    for (let i = 0; i < recentIPOs.length; i += BATCH) {
      const batch = recentIPOs.slice(i, i + BATCH);

      const results = await Promise.allSettled(
        batch.map(s => fetchScreenerIPOData(s.symbol || s.Symbol))
      );

      for (let j = 0; j < batch.length; j++) {
        const raw = batch[j];
        const symbol = raw.symbol || raw.Symbol;
        const r = results[j];

        const dateField = raw.listingDate || raw.listingDt || raw.listing_date || raw.listDate;
        const issuePrice = parseFloat(raw.issuePrice || raw.cutOffPrice || raw.ipoPrice || 0);
        const screener = r.status === 'fulfilled' ? r.value : null;

        const currentPrice = screener?.price || parseFloat(raw.ltp || raw.lastPrice || 0);

        enriched.push({
          symbol,
          name: raw.companyName || raw.company || symbol,
          sector: screener?.sector || raw.sector || 'N/A',
          list_date: dateField,
          days_listed: daysBetween(dateField),
          issue_price: issuePrice,
          price: currentPrice,
          listing_return: issuePrice > 0 && currentPrice > 0
            ? Math.round(((currentPrice - issuePrice) / issuePrice) * 1000) / 10
            : null,
          mcap: screener?.mcap || null,
          pe: screener?.pe || null,
          avg_val: screener?.avg_val || null
        });
      }

      if (i + BATCH < recentIPOs.length) await sleep(300);
    }

    cache = enriched;
    cacheAt = Date.now();

    const filtered = applyFilters(enriched, { priceMin, valMin, MCAP_HARD_MIN });
    return sendOk(res, { count: filtered.length, stocks: filtered });

  } catch (e) {
    console.error('IPO scan error:', e.message);
    return sendError(res, 500, 'IPO scan failed: ' + e.message);
  }
};

function applyFilters(stocks, { priceMin, valMin, MCAP_HARD_MIN }) {
  return stocks
    .filter(s => {
      if (s.mcap !== null && s.mcap < MCAP_HARD_MIN) return false;
      if (s.price !== null && s.price < priceMin) return false;
      if (s.avg_val !== null && s.avg_val < valMin) return false;
      return true;
    })
    .sort((a, b) => (b.days_listed !== null ? -b.days_listed : 1) - (a.days_listed !== null ? -a.days_listed : 1));
  // Newest first = smallest days_listed first
}
