// _utils.js v4
// Working sources confirmed: Yahoo Finance, Screener.in, Moneycontrol
// Dead: allorigins proxy (timeout), NSE direct (403), BSE direct (HTML error)
// New proxy strategy: use multiple free CORS proxies with short timeouts

const PROXIES = [
  'https://corsproxy.io/?',
  'https://api.codetabs.com/v1/proxy?quest=',
  'https://thingproxy.freeboard.io/fetch/',
];

async function fetchWithTimeout(url, opts = {}, ms = 7000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(id);
    return r;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// Try multiple proxies with short per-proxy timeout
async function fetchViaProxy(url, json = true) {
  for (const proxy of PROXIES) {
    try {
      const r = await fetchWithTimeout(proxy + encodeURIComponent(url), {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      }, 6000);
      if (!r.ok) continue;
      const ct = r.headers.get('content-type') || '';
      if (json) {
        const text = await r.text();
        // Guard against HTML error pages
        if (text.trim().startsWith('<')) throw new Error('Got HTML instead of JSON');
        return JSON.parse(text);
      }
      return r.text();
    } catch (e) {
      continue; // try next proxy
    }
  }
  throw new Error('All proxies failed for: ' + url);
}

// Direct fetch — for Screener, Yahoo, Moneycontrol (confirmed working)
async function fetchDirect(url, json = true, extraHeaders = {}) {
  const r = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': json ? 'application/json,*/*' : 'text/html,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...extraHeaders
    }
  }, 8000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (json) {
    const text = await r.text();
    if (text.trim().startsWith('<')) throw new Error('Got HTML instead of JSON');
    return JSON.parse(text);
  }
  return r.text();
}

// Yahoo Finance — confirmed working ✅
async function fetchYahoo(symbol, range = '1y', interval = '1d') {
  const sym = symbol.includes('.') ? symbol : symbol + '.NS';
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=${interval}&includePrePost=false`;
      const data = await fetchDirect(url, true, { 'Referer': 'https://finance.yahoo.com/' });
      const result = data?.chart?.result?.[0];
      if (result) return result;
    } catch {}
  }
  throw new Error('Yahoo failed for ' + symbol);
}

// Screener.in HTML — confirmed working ✅ (but price field needs fix)
async function fetchScreenerHTML(symbol) {
  for (const url of [
    `https://www.screener.in/company/${symbol}/consolidated/`,
    `https://www.screener.in/company/${symbol}/`
  ]) {
    try {
      const html = await fetchDirect(url, false, { 'Referer': 'https://www.screener.in/' });
      if (html && html.length > 3000) return html;
    } catch {}
  }
  return null;
}

// Parse Screener HTML — fixed price detection
function parseScreener(html) {
  const out = { price: null, mcap: null, pe: null, sector: 'N/A', avg_val: null, quarters: [] };
  if (!html) return out;
  try {
    // Price — Screener shows price in multiple ways, try all
    const prPatterns = [
      // Main price in top section
      /<span[^>]*class="[^"]*number[^"]*"[^>]*>\s*([\d,]+\.?\d*)\s*<\/span>/,
      // JSON embedded in page
      /"price"\s*:\s*"?([\d.]+)"?/,
      // Ratio section current price
      /Current Price[^<]*<\/[^>]+>[^<]*<[^>]+>\s*₹?\s*([\d,]+\.?\d*)/i,
      // Any span with rupee symbol nearby
      /₹\s*([\d,]+\.?\d*)/,
      // Data attribute
      /data-price="([\d.]+)"/,
    ];
    for (const p of prPatterns) {
      const m = html.match(p);
      if (m) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (v > 0 && v < 1000000) { out.price = v; break; }
      }
    }

    // MCap — confirmed working ✓
    const mcM = html.match(/Market Cap[^<]*<\/[^>]+>\s*<[^>]+>\s*₹?\s*([\d,]+\.?\d*)/i);
    if (mcM) out.mcap = parseFloat(mcM[1].replace(/,/g, ''));

    // PE — confirmed working ✓
    const peM = html.match(/Stock P\/E[^<]*<\/[^>]+>\s*<[^>]+>\s*([\d.]+)/i);
    if (peM) out.pe = parseFloat(peM[1]);

    // Sector
    const secM = html.match(/"industry"\s*:\s*"([^"]{2,50})"/i)
      || html.match(/"sector"\s*:\s*"([^"]{2,50})"/i)
      || html.match(/sector[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{3,40})<\//i);
    if (secM) out.sector = secM[1].trim();

    // Quarters — confirmed working ✓
    const qSec = html.match(/id="quarters"([\s\S]{0,6000}?)(?=id="|<\/section>)/i);
    if (qSec) {
      const tbl = qSec[1];
      const hRe = /<th[^>]*>\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[^<]{0,15})<\/th>/gi;
      const hdrs = []; let hm;
      while ((hm = hRe.exec(tbl)) !== null && hdrs.length < 5) hdrs.push(hm[1].trim());

      function getRowNums(label) {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('>' + escaped + '<[\\s\\S]{0,400}?<\\/tr>', 'i');
        const rm = tbl.match(re);
        if (!rm) return [];
        const nums = []; const tdRe = /<td[^>]*>\s*([\d,\-]+\.?\d*)\s*<\/td>/g; let tm;
        while ((tm = tdRe.exec(rm[0])) !== null) {
          const v = parseFloat(tm[1].replace(/,/g, ''));
          if (!isNaN(v)) nums.push(v);
        }
        return nums;
      }

      const sales = getRowNums('Sales');
      const pat   = getRowNums('Net Profit');
      for (let i = 0; i < Math.min(hdrs.length, 4); i++) {
        out.quarters.push({ label: hdrs[i], revenue: sales[i] ?? null, pat: pat[i] ?? null });
      }
    }

    // Avg daily value — estimate from vol if available
    const volM = html.match(/(?:10|30)\s*Day\s*Avg[^<]*<\/[^>]+>\s*<[^>]+>\s*([\d,]+)/i);
    if (volM && out.price) {
      out.avg_val = Math.round(parseFloat(volM[1].replace(/,/g,'')) * out.price / 1e7 * 10) / 10;
    }
  } catch {}
  return out;
}

// EMA
function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return Math.round(ema * 100) / 100;
}

// RS Score — MarketSmith method
function calcRS(closes) {
  if (!closes || closes.length < 60) return null;
  const len = closes.length;
  const perf = (si, ei) => { const s = closes[si], e = closes[Math.min(ei,len)-1]; return s>0?(e-s)/s:0; };
  const q4s=Math.max(0,len-63), q3s=Math.max(0,len-126), q2s=Math.max(0,len-189), q1s=Math.max(0,len-252);
  return (perf(q4s,len)*2 + perf(q3s,q4s) + perf(q2s,q3s) + perf(q1s,q2s)) / 5;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sendError(res, status, msg) { return res.status(status).json({ error: true, message: msg }); }
function sendOk(res, data) { return res.status(200).json({ error: false, ...data }); }

module.exports = { fetchViaProxy, fetchDirect, fetchYahoo, fetchScreenerHTML, parseScreener, calcEMA, calcRS, sleep, sendError, sendOk };
