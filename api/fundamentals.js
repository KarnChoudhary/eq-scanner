// api/fundamentals.js
// Batch fundamentals fetcher: MCap, PE, Sector, Avg Daily Value
// Used by RS and Gainers scans to enrich results after initial scan
// Accepts: ?symbols=RELIANCE,INFY,TCS (comma separated, max 20)
// Sources: Screener.in (primary), NSE quote API (price/volume fallback)

const { fetchNSE, sendError, sendOk, sleep } = require('./_utils');

// Per-symbol cache: 30 min TTL
const symCache = {};
const SYM_TTL = 30 * 60 * 1000;

async function fetchNSEQuote(symbol) {
  try {
    const data = await fetchNSE(`/api/quote-equity?symbol=${encodeURIComponent(symbol)}`);
    if (!data) return null;

    const info = data.info || {};
    const priceInfo = data.priceInfo || {};
    const securityInfo = data.securityInfo || {};
    const industryInfo = data.industryInfo || {};
    const metadata = data.metadata || {};

    // Market cap from NSE (in Crores)
    let mcap = null;
    if (priceInfo.lastPrice && securityInfo.issuedSize) {
      mcap = Math.round((priceInfo.lastPrice * securityInfo.issuedSize) / 1e7) / 100;
    }

    // Avg daily volume value (Cr) — using 2-week avg traded value
    let avgVal = null;
    try {
      const tradeInfo = await fetchNSE(`/api/quote-equity?symbol=${encodeURIComponent(symbol)}&section=trade_info`);
      if (tradeInfo?.marketDeptOrderBook?.tradeInfo) {
        const ti = tradeInfo.marketDeptOrderBook.tradeInfo;
        // totalTradedValue is in Lakhs on NSE, convert to Cr
        avgVal = ti.totalTradedValue ? Math.round(ti.totalTradedValue / 100) : null;
      }
    } catch (e) {
      // ignore trade info failure
    }

    return {
      price: priceInfo.lastPrice || null,
      mcap,
      pe: priceInfo.pdSymbolPe || null,
      sector: industryInfo.macro || industryInfo.sector || null,
      industry: industryInfo.industry || null,
      avg_val: avgVal
    };
  } catch (e) {
    console.warn(`NSE quote failed for ${symbol}:`, e.message);
    return null;
  }
}

async function fetchScreenerFundamentals(symbol) {
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
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.screener.in/'
        }
      });
      if (!res.ok) continue;
      const html = await res.text();
      return parseScreenerHTML(html);
    } catch {
      continue;
    }
  }
  return null;
}

function parseScreenerHTML(html) {
  const result = {
    mcap: null,
    pe: null,
    price: null,
    sector: null,
    industry: null,
    avg_val: null
  };

  try {
    // Market Cap (Cr)
    const mcapRe = /Market Cap\s*<\/td>\s*<td[^>]*>\s*₹?\s*([\d,]+(?:\.\d+)?)\s*<\/td>/i;
    const mcapM = html.match(mcapRe);
    if (mcapM) result.mcap = parseFloat(mcapM[1].replace(/,/g, ''));

    // Current price
    const prRe = /id="current-price"[^>]*>([\d,]+(?:\.\d+)?)/i;
    const prM = html.match(prRe);
    if (prM) result.price = parseFloat(prM[1].replace(/,/g, ''));

    // Stock PE
    const peRe = /Stock P\/E\s*<\/td>\s*<td[^>]*>\s*([\d.]+)\s*<\/td>/i;
    const peM = html.match(peRe);
    if (peM) result.pe = parseFloat(peM[1]);

    // Sector from JSON-LD structured data
    const jsonLdRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i;
    const jsonM = html.match(jsonLdRe);
    if (jsonM) {
      try {
        const jd = JSON.parse(jsonM[1]);
        if (jd.industry) result.industry = jd.industry;
        if (jd.sector) result.sector = jd.sector;
      } catch { /* ignore JSON parse errors */ }
    }

    // Fallback sector from breadcrumb
    if (!result.sector) {
      const breadRe = /class="[^"]*breadcrumb[^"]*"[\s\S]*?<a[^>]*href="\/screen\/[^"]*sector[^"]*"[^>]*>([^<]+)<\/a>/i;
      const breadM = html.match(breadRe);
      if (breadM) result.sector = breadM[1].trim();
    }

    // Avg daily traded value - Screener shows "Avg. 10 Day Vol" or similar
    // We calculate from NSE or estimate from data available
    // Screener shows "Market Lot" and trade volume in some pages
    const volRe = /Avg\.\s*(?:10|30)\s*Day\s*Vol[^<]*<\/td>\s*<td[^>]*>\s*([\d,]+)/i;
    const volM = html.match(volRe);
    if (volM && result.price) {
      const vol = parseFloat(volM[1].replace(/,/g, ''));
      // Avg daily traded value in Cr = (vol * price) / 1e7
      result.avg_val = Math.round((vol * result.price) / 1e7 * 100) / 100;
    }

  } catch (e) {
    console.error('Screener parse error:', e.message);
  }

  return result;
}

async function getFundamentals(symbol) {
  const cached = symCache[symbol];
  if (cached && Date.now() - cached.at < SYM_TTL) return cached.data;

  // Try Screener first (richer data)
  let data = await fetchScreenerFundamentals(symbol);

  // Fallback to NSE if Screener fails or MCap missing
  if (!data || (!data.mcap && !data.price)) {
    const nseData = await fetchNSEQuote(symbol);
    if (nseData) {
      data = {
        mcap: nseData.mcap,
        pe: data?.pe || nseData.pe,
        price: data?.price || nseData.price,
        sector: data?.sector || nseData.sector,
        industry: data?.industry || nseData.industry,
        avg_val: data?.avg_val || nseData.avg_val
      };
    }
  }

  if (!data) data = { mcap: null, pe: null, price: null, sector: 'N/A', industry: null, avg_val: null };

  symCache[symbol] = { data, at: Date.now() };
  return data;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const symbolsParam = req.query.symbols || '';
  if (!symbolsParam) return sendError(res, 400, 'symbols parameter required');

  const symbols = symbolsParam
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 25); // max 25 per request

  if (!symbols.length) return sendError(res, 400, 'No valid symbols provided');

  try {
    const results = {};
    const BATCH = 5;

    for (let i = 0; i < symbols.length; i += BATCH) {
      const batch = symbols.slice(i, i + BATCH);
      const fetched = await Promise.allSettled(
        batch.map(sym => getFundamentals(sym))
      );
      fetched.forEach((r, j) => {
        results[batch[j]] = r.status === 'fulfilled' ? r.value : {
          mcap: null, pe: null, price: null, sector: 'N/A', avg_val: null, error: true
        };
      });
      if (i + BATCH < symbols.length) await sleep(200);
    }

    return sendOk(res, { fundamentals: results });
  } catch (e) {
    console.error('Fundamentals error:', e.message);
    return sendError(res, 500, 'Fundamentals fetch failed: ' + e.message);
  }
};
