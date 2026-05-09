// api/_utils.js
// Shared utilities for all proxy endpoints

const NSE_BASE = 'https://www.nseindia.com';

// NSE requires a session cookie obtained from the homepage first.
// We fetch homepage once per cold start to get cookies.
let nseCookies = '';
let cookieFetchedAt = 0;
const COOKIE_TTL = 10 * 60 * 1000; // 10 minutes

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.nseindia.com/',
  'Origin': 'https://www.nseindia.com',
  'sec-ch-ua': '"Chromium";v="124"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'Connection': 'keep-alive'
};

async function refreshNseCookies() {
  const now = Date.now();
  if (nseCookies && now - cookieFetchedAt < COOKIE_TTL) return nseCookies;

  try {
    const res = await fetch(NSE_BASE, {
      headers: {
        'User-Agent': NSE_HEADERS['User-Agent'],
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      // Extract cookie names and values only (strip attributes)
      nseCookies = setCookie
        .split(',')
        .map(c => c.split(';')[0].trim())
        .filter(c => c.includes('='))
        .join('; ');
    }
    cookieFetchedAt = now;
    return nseCookies;
  } catch (e) {
    console.error('NSE cookie refresh failed:', e.message);
    return '';
  }
}

async function fetchNSE(path, retries = 2) {
  const cookies = await refreshNseCookies();
  const url = NSE_BASE + path;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          ...NSE_HEADERS,
          ...(cookies ? { 'Cookie': cookies } : {})
        }
      });
      
      if (!res.ok) {
        if (attempt === retries) throw new Error(`NSE HTTP ${res.status} for ${path}`);
        await sleep(500 * (attempt + 1));
        continue;
      }
      
      const data = await res.json();
      return data;
    } catch (e) {
      if (attempt === retries) throw e;
      await sleep(500 * (attempt + 1));
    }
  }
}

async function fetchScreener(symbol) {
  // Screener.in public company page - returns HTML, we parse JSON from script tag
  const url = `https://www.screener.in/company/${symbol}/consolidated/`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': NSE_HEADERS['User-Agent'],
        'Accept': 'text/html',
        'Referer': 'https://www.screener.in/'
      }
    });
    if (!res.ok) throw new Error(`Screener HTTP ${res.status}`);
    const html = await res.text();
    return html;
  } catch (e) {
    // Try standalone (non-consolidated)
    try {
      const res = await fetch(`https://www.screener.in/company/${symbol}/`, {
        headers: {
          'User-Agent': NSE_HEADERS['User-Agent'],
          'Accept': 'text/html',
          'Referer': 'https://www.screener.in/'
        }
      });
      if (!res.ok) throw new Error(`Screener standalone HTTP ${res.status}`);
      return await res.text();
    } catch (e2) {
      throw new Error(`Screener fetch failed for ${symbol}: ${e2.message}`);
    }
  }
}

// Parse key fundamentals from Screener HTML
function parseScreenerFundamentals(html) {
  const result = {
    mcap: null,
    pe: null,
    sector: null,
    industry: null,
    avg_daily_val: null
  };

  try {
    // MCap - appears as "Market Cap" in ratios section
    const mcapMatch = html.match(/Market Cap[^<]*<\/td>[^<]*<td[^>]*>.*?₹?\s*([\d,]+(?:\.\d+)?)\s*Cr/is);
    if (mcapMatch) result.mcap = parseFloat(mcapMatch[1].replace(/,/g, ''));

    // PE ratio
    const peMatch = html.match(/Stock P\/E[^<]*<\/td>[^<]*<td[^>]*>\s*([\d.]+)\s*<\/td>/is);
    if (peMatch) result.pe = parseFloat(peMatch[1]);

    // Sector/Industry from breadcrumb or metadata
    const sectorMatch = html.match(/sector['":\s]+([A-Za-z &]+)/i);
    if (sectorMatch) result.sector = sectorMatch[1].trim();

  } catch (e) {
    console.error('Screener parse error:', e.message);
  }

  return result;
}

async function fetchYahoo(symbol, range = '1y', interval = '1d') {
  // symbol should be like RELIANCE.NS
  const yahooSym = symbol.includes('.') ? symbol : symbol + '.NS';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?range=${range}&interval=${interval}&includePrePost=false`;
  
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': NSE_HEADERS['User-Agent'],
        'Accept': 'application/json',
        'Referer': 'https://finance.yahoo.com/'
      }
    });
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    const data = await res.json();
    return data?.chart?.result?.[0] || null;
  } catch (e) {
    // Fallback: try query2
    try {
      const url2 = `https://query2.finance.yahoo.com/v8/finance/chart/${yahooSym}?range=${range}&interval=${interval}&includePrePost=false`;
      const res2 = await fetch(url2, {
        headers: {
          'User-Agent': NSE_HEADERS['User-Agent'],
          'Accept': 'application/json'
        }
      });
      if (!res2.ok) throw new Error(`Yahoo2 HTTP ${res2.status}`);
      const data2 = await res2.json();
      return data2?.chart?.result?.[0] || null;
    } catch (e2) {
      throw new Error(`Yahoo fetch failed for ${symbol}: ${e2.message}`);
    }
  }
}

// Calculate EMA from close prices array
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return Math.round(ema * 100) / 100;
}

// Calculate RS score using MarketSmith 12-month weighted method
// Splits 252 trading days into 4 quarters, weights most recent 2x
function calcRS(closes) {
  if (!closes || closes.length < 60) return null;
  const len = closes.length;
  const q1Start = Math.max(0, len - 252);
  const q2Start = Math.max(0, len - 189); // ~9 months ago
  const q3Start = Math.max(0, len - 126); // ~6 months ago
  const q4Start = Math.max(0, len - 63);  // ~3 months ago (most recent)

  const perf = (startIdx, endIdx) => {
    const start = closes[startIdx];
    const end = closes[endIdx - 1] || closes[len - 1];
    if (!start || start === 0) return 0;
    return (end - start) / start;
  };

  const p1 = perf(q1Start, q2Start);
  const p2 = perf(q2Start, q3Start);
  const p3 = perf(q3Start, q4Start);
  const p4 = perf(q4Start, len); // most recent quarter - gets 2x weight

  const rsScore = (p4 * 2 + p3 + p2 + p1) / 5;
  return rsScore;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendError(res, status, message) {
  return res.status(status).json({ error: true, message });
}

function sendOk(res, data) {
  return res.status(200).json({ error: false, ...data });
}

module.exports = {
  fetchNSE,
  fetchScreener,
  parseScreenerFundamentals,
  fetchYahoo,
  calcEMA,
  calcRS,
  sleep,
  sendError,
  sendOk
};
