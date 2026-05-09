// api/_utils.js v3
// NSE blocks Vercel IPs directly. Strategy:
// 1. Use allorigins.win CORS proxy for NSE API calls
// 2. Use Yahoo Finance (working) for price data
// 3. Use Screener.in JSON API (not HTML scrape) for fundamentals
// 4. Use RapidAPI-free alternatives where needed

const PROXY = 'https://api.allorigins.win/raw?url=';
const PROXY2 = 'https://corsproxy.io/?';

async function fetchViaProxy(url, json = true) {
  const proxies = [
    PROXY + encodeURIComponent(url),
    PROXY2 + encodeURIComponent(url),
  ];
  let lastErr;
  for (const purl of proxies) {
    try {
      const r = await fetch(purl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (!r.ok) { lastErr = new Error('HTTP ' + r.status); continue; }
      return json ? r.json() : r.text();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('All proxies failed for ' + url);
}

// Direct fetch with browser-like headers (works for non-NSE sites)
async function fetchDirect(url, json = true, extraHeaders = {}) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': json ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...extraHeaders
    },
    signal: AbortSignal.timeout(9000)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return json ? r.json() : r.text();
}

// Yahoo Finance — WORKING. Use for all price data.
async function fetchYahoo(symbol, range = '1y', interval = '1d') {
  const sym = symbol.includes('.') ? symbol : symbol + '.NS';
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=${interval}&includePrePost=false`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=${interval}&includePrePost=false`,
  ];
  for (const url of urls) {
    try {
      const data = await fetchDirect(url, true, { 'Referer': 'https://finance.yahoo.com/' });
      const result = data?.chart?.result?.[0];
      if (result) return result;
    } catch {}
  }
  throw new Error('Yahoo failed for ' + symbol);
}

// Screener.in JSON API — works better than HTML scrape
// Screener has an undocumented JSON endpoint
async function fetchScreenerJSON(symbol) {
  const urls = [
    `https://www.screener.in/api/company/search/?q=${symbol}`,
    `https://www.screener.in/company/${symbol}/`,
  ];
  // Try JSON search first
  try {
    const data = await fetchDirect(
      `https://www.screener.in/api/company/search/?q=${encodeURIComponent(symbol)}&v=3`,
      true,
      { 'Referer': 'https://www.screener.in/', 'X-Requested-With': 'XMLHttpRequest' }
    );
    if (Array.isArray(data) && data.length) return { searchResults: data };
  } catch {}
  return null;
}

// Screener HTML with better selectors
async function fetchScreenerHTML(symbol) {
  const pages = [
    `https://www.screener.in/company/${symbol}/consolidated/`,
    `https://www.screener.in/company/${symbol}/`,
  ];
  for (const url of pages) {
    try {
      const html = await fetchDirect(url, false, { 'Referer': 'https://www.screener.in/' });
      if (html && html.length > 5000) return { html, url };
    } catch {}
  }
  return null;
}

function parseScreenerData(html) {
  const out = { price: null, mcap: null, pe: null, sector: 'N/A', avg_val: null, quarters: [] };
  if (!html) return out;
  try {
    // Price — multiple patterns
    const prPatterns = [
      /class="[^"]*number[^"]*"[^>]*>\s*([\d,]+\.?\d*)/,
      /"price"\s*:\s*([\d.]+)/,
      /₹\s*([\d,]+\.?\d*)\s*<\/span>/,
      /Current Price[^<]*<\/[^>]+>[^<]*<[^>]+>\s*₹?\s*([\d,]+\.?\d*)/i,
    ];
    for (const p of prPatterns) {
      const m = html.match(p);
      if (m) { out.price = parseFloat(m[1].replace(/,/g, '')); break; }
    }

    // MCap
    const mcPatterns = [
      /Market Cap[^<]*<\/[^>]+>\s*<[^>]+>\s*₹?\s*([\d,]+\.?\d*)\s*(?:Cr)?/i,
      /"market_cap_full"\s*:\s*([\d.]+)/i,
    ];
    for (const p of mcPatterns) {
      const m = html.match(p);
      if (m) { out.mcap = parseFloat(m[1].replace(/,/g, '')); break; }
    }

    // PE
    const pePatterns = [
      /Stock P\/E[^<]*<\/[^>]+>\s*<[^>]+>\s*([\d.]+)/i,
      /"pe"\s*:\s*([\d.]+)/i,
      /P\/E Ratio[^<]*<\/[^>]+>\s*<[^>]+>\s*([\d.]+)/i,
    ];
    for (const p of pePatterns) {
      const m = html.match(p);
      if (m) { out.pe = parseFloat(m[1]); break; }
    }

    // Sector
    const secPatterns = [
      /"industry"\s*:\s*"([^"]+)"/i,
      /"sector"\s*:\s*"([^"]+)"/i,
      /class="[^"]*breadcrumb[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]{3,40})<\/a>\s*<\/li>\s*<li/i,
    ];
    for (const p of secPatterns) {
      const m = html.match(p);
      if (m && m[1].trim().length > 2) { out.sector = m[1].trim(); break; }
    }

    // Quarters — Screener renders in <section id="quarters">
    // Try to find quarterly financials table
    const qMatch = html.match(/id="quarters"([\s\S]{0,8000})/i);
    if (qMatch) {
      const tbl = qMatch[1];
      // Quarter headers
      const hRe = /<th[^>]*>\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[^<]{0,20})<\/th>/gi;
      const hdrs = []; let hm;
      while ((hm = hRe.exec(tbl)) !== null && hdrs.length < 6) hdrs.push(hm[1].trim());

      const getRowNums = (label) => {
        const re = new RegExp('>' + label + '<[\\s\\S]{0,500}?<\\/tr>', 'i');
        const rm = tbl.match(re);
        if (!rm) return [];
        const nums = []; const tdRe = /<td[^>]*>\s*([\d,\-]+\.?\d*)\s*<\/td>/g; let tm;
        while ((tm = tdRe.exec(rm[0])) !== null) {
          const v = parseFloat(tm[1].replace(/,/g, ''));
          if (!isNaN(v)) nums.push(v);
        }
        return nums;
      };

      const sales = getRowNums('Sales');
      const pat   = getRowNums('Net Profit');
      for (let i = 0; i < Math.min(hdrs.length, 4); i++) {
        out.quarters.push({ label: hdrs[i], revenue: sales[i] ?? null, pat: pat[i] ?? null });
      }
    }

    // Avg daily value estimate
    const volRe = /(?:10|30)\s*Day\s*Avg[^<]*<\/[^>]+>\s*<[^>]+>\s*([\d,]+)/i;
    const volM = html.match(volRe);
    if (volM && out.price) {
      out.avg_val = Math.round(parseFloat(volM[1].replace(/,/g,'')) * out.price / 1e7 * 10) / 10;
    }
  } catch {}
  return out;
}

// EMA calculation
function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return Math.round(ema * 100) / 100;
}

// RS Score (MarketSmith method)
function calcRS(closes) {
  if (!closes || closes.length < 60) return null;
  const len = closes.length;
  const perf = (si, ei) => { const s = closes[si], e = closes[Math.min(ei, len) - 1]; return s > 0 ? (e - s) / s : 0; };
  const q4s = Math.max(0, len - 63), q3s = Math.max(0, len - 126), q2s = Math.max(0, len - 189), q1s = Math.max(0, len - 252);
  return (perf(q4s, len) * 2 + perf(q3s, q4s) + perf(q2s, q3s) + perf(q1s, q2s)) / 5;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sendError(res, status, msg) { return res.status(status).json({ error: true, message: msg }); }
function sendOk(res, data) { return res.status(200).json({ error: false, ...data }); }

module.exports = { fetchViaProxy, fetchDirect, fetchYahoo, fetchScreenerHTML, parseScreenerData, calcEMA, calcRS, sleep, sendError, sendOk };
