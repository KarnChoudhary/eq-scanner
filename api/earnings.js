// api/earnings.js
// Scan 1: Earnings Surprise
// Fetches recent quarterly results from Trendlyne public results calendar
// Filters: both Rev QoQ% AND PAT QoQ% above threshold, within last 30 days
// Fundamentals (MCap, PE, Sector) from Screener.in

const { sendError, sendOk, sleep } = require('./_utils');

// In-memory cache: 30 min TTL
let cache = null;
let cacheAt = 0;
const TTL = 30 * 60 * 1000;

async function fetchTrendlyneResults() {
  // Trendlyne's quarterly results page - public, no auth needed
  // Returns last 30 days of result announcements
  const url = 'https://trendlyne.com/equity/latest-quarterly-results/';
  
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': 'https://trendlyne.com/',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    }
  });

  if (!res.ok) throw new Error(`Trendlyne HTTP ${res.status}`);
  return await res.text();
}

async function fetchScreenerQuarterly(symbol) {
  // Fetch Screener.in company page to get quarterly financials + fundamentals
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
      return parseScreenerData(html, symbol);
    } catch (e) {
      continue;
    }
  }
  return null;
}

function parseScreenerData(html, symbol) {
  const data = {
    symbol,
    mcap: null,
    pe: null,
    sector: null,
    avg_daily_val: null,
    price: null,
    quarters: [] // [{label, revenue, pat}]
  };

  try {
    // Market Cap
    const mcapRe = /Market Cap\s*<\/td>\s*<td[^>]*>\s*₹?\s*([\d,]+(?:\.\d+)?)\s*<\/td>/i;
    const mcapM = html.match(mcapRe);
    if (mcapM) data.mcap = parseFloat(mcapM[1].replace(/,/g, ''));

    // Current Price
    const priceRe = /id="current-price"[^>]*>([\d,]+(?:\.\d+)?)/i;
    const priceM = html.match(priceRe);
    if (priceM) data.price = parseFloat(priceM[1].replace(/,/g, ''));

    // PE
    const peRe = /Stock P\/E\s*<\/td>\s*<td[^>]*>\s*([\d.]+)\s*<\/td>/i;
    const peM = html.match(peRe);
    if (peM) data.pe = parseFloat(peM[1]);

    // Sector - from breadcrumb metadata
    const sectorRe = /class="[^"]*breadcrumb[^"]*"[^>]*>.*?<a[^>]*>([^<]+)<\/a>\s*<\/li>\s*<li/is;
    const sectorM = html.match(sectorRe);
    if (sectorM) data.sector = sectorM[1].trim();

    // Quarterly Results table - parse revenue (Sales) and PAT rows
    // Screener renders these in a table with class "data-table"
    // We look for the Quarterly Results section
    const qResultsRe = /Quarterly Results[\s\S]*?<table[\s\S]*?<\/table>/i;
    const qTableM = html.match(qResultsRe);

    if (qTableM) {
      const tableHtml = qTableM[0];
      
      // Extract column headers (quarter labels like "Mar 2025", "Dec 2024")
      const headerRe = /<th[^>]*>((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})<\/th>/gi;
      const headers = [];
      let hm;
      while ((hm = headerRe.exec(tableHtml)) !== null) {
        headers.push(hm[1]);
      }

      // Extract Sales row
      const salesRe = /Sales[\s\S]*?<\/tr>/i;
      const salesM = tableHtml.match(salesRe);
      const salesVals = salesM ? extractRowValues(salesM[0]) : [];

      // Extract PAT row (Net Profit)
      const patRe = /Net Profit[\s\S]*?<\/tr>/i;
      const patM = tableHtml.match(patRe);
      const patVals = patM ? extractRowValues(patM[0]) : [];

      // Build quarters array (most recent first)
      for (let i = 0; i < Math.min(headers.length, 4); i++) {
        data.quarters.push({
          label: headers[i],
          revenue: salesVals[i] || null,
          pat: patVals[i] || null
        });
      }
    }

  } catch (e) {
    console.error('Screener parse error for', symbol, e.message);
  }

  return data;
}

function extractRowValues(rowHtml) {
  const vals = [];
  const tdRe = /<td[^>]*>([\d,\-\.]+)<\/td>/g;
  let m;
  while ((m = tdRe.exec(rowHtml)) !== null) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (!isNaN(v)) vals.push(v);
  }
  return vals;
}

function calcQoQ(current, previous) {
  if (!current || !previous || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function isWithinDays(dateStr, days) {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now - d;
    return diffMs >= 0 && diffMs <= days * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const revThresh = parseFloat(req.query.rev_thresh) || 20;
  const patThresh = parseFloat(req.query.pat_thresh) || 20;
  const mcapMin = parseFloat(req.query.mcap_min) || 1000;
  const mcapMax = parseFloat(req.query.mcap_max) || 50000;
  const priceMin = parseFloat(req.query.price_min) || 20;
  const peMax = parseFloat(req.query.pe_max) || 35;
  const valMin = parseFloat(req.query.val_min) || 5;

  // Return cache if valid and same params would yield same raw data
  if (cache && Date.now() - cacheAt < TTL) {
    const filtered = applyFilters(cache, { revThresh, patThresh, mcapMin, mcapMax, priceMin, peMax, valMin });
    return sendOk(res, { count: filtered.length, stocks: filtered, cached: true });
  }

  try {
    // Step 1: Get recent results from Trendlyne
    // Trendlyne has a public API endpoint for latest results
    const trendlyneApiUrl = 'https://trendlyne.com/api/latest-quarterly-results/?format=json&page=1&limit=100';
    
    let resultsList = [];
    try {
      const tlRes = await fetch(trendlyneApiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://trendlyne.com/equity/latest-quarterly-results/',
          'X-Requested-With': 'XMLHttpRequest'
        }
      });
      
      if (tlRes.ok) {
        const tlData = await tlRes.json();
        // Trendlyne returns array of result objects
        // Each has: symbol, company_name, result_date, revenue, pat, revenue_prev, pat_prev etc.
        resultsList = Array.isArray(tlData) ? tlData : (tlData.results || tlData.data || []);
      }
    } catch (e) {
      console.warn('Trendlyne API failed, trying NSE results:', e.message);
    }

    // Fallback: NSE corporate results board
    if (!resultsList.length) {
      try {
        const { fetchNSE } = require('./_utils');
        const nseResults = await fetchNSE('/api/corporate-announcements?index=equities&subject=Financial+Results');
        if (nseResults && Array.isArray(nseResults)) {
          resultsList = nseResults.map(r => ({
            symbol: r.symbol,
            company_name: r.company || r.companyName,
            result_date: r.bcastDt || r.an_dt,
            source: 'nse'
          }));
        }
      } catch (e2) {
        console.warn('NSE results fallback also failed:', e2.message);
      }
    }

    // Step 2: Filter to last 30 days
    const recent = resultsList.filter(r => isWithinDays(r.result_date || r.date, 30));

    if (!recent.length) {
      return sendOk(res, { count: 0, stocks: [], note: 'No results found in last 30 days. Data sources may be temporarily unavailable.' });
    }

    // Step 3: For each recent result, get Screener data for QoQ and fundamentals
    // Process in batches to avoid rate limiting
    const BATCH = 5;
    const enriched = [];

    for (let i = 0; i < Math.min(recent.length, 60); i += BATCH) {
      const batch = recent.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(r => fetchScreenerQuarterly(r.symbol))
      );

      for (let j = 0; j < batch.length; j++) {
        const raw = batch[j];
        const screenerResult = results[j];

        if (screenerResult.status !== 'fulfilled' || !screenerResult.value) continue;
        const s = screenerResult.value;

        if (!s.quarters || s.quarters.length < 2) continue;

        const q0 = s.quarters[0]; // most recent
        const q1 = s.quarters[1]; // previous quarter

        const revQoQ = calcQoQ(q0.revenue, q1.revenue);
        const patQoQ = calcQoQ(q0.pat, q1.pat);

        if (revQoQ === null || patQoQ === null) continue;

        enriched.push({
          symbol: raw.symbol,
          name: raw.company_name || s.symbol,
          sector: s.sector || 'N/A',
          result_date: raw.result_date || raw.date,
          revenue: q0.revenue,
          rev_qoq: Math.round(revQoQ * 10) / 10,
          pat: q0.pat,
          pat_qoq: Math.round(patQoQ * 10) / 10,
          mcap: s.mcap,
          pe: s.pe,
          price: s.price,
          avg_val: s.avg_daily_val
        });
      }

      if (i + BATCH < recent.length) await sleep(300); // rate limit courtesy
    }

    cache = enriched;
    cacheAt = Date.now();

    const filtered = applyFilters(enriched, { revThresh, patThresh, mcapMin, mcapMax, priceMin, peMax, valMin });
    return sendOk(res, { count: filtered.length, stocks: filtered });

  } catch (e) {
    console.error('Earnings scan error:', e.message);
    return sendError(res, 500, 'Earnings scan failed: ' + e.message);
  }
};

function applyFilters(stocks, f) {
  return stocks
    .filter(s => {
      if (s.rev_qoq < f.revThresh) return false;
      if (s.pat_qoq < f.patThresh) return false;
      if (s.mcap !== null && s.mcap < f.mcapMin) return false;
      if (s.mcap !== null && s.mcap > f.mcapMax) return false;
      if (s.price !== null && s.price < f.priceMin) return false;
      if (s.pe !== null && s.pe > f.peMax) return false;
      if (s.avg_val !== null && s.avg_val < f.valMin) return false;
      return true;
    })
    .sort((a, b) => b.pat_qoq - a.pat_qoq);
}
