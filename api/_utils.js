// _utils.js v5
// Confirmed working: Yahoo Finance ✅, Screener.in HTML ✅ (needs correct parsing), Moneycontrol HTML ✅
// Dead: corsproxy.io (403), allorigins (timeout), NSE direct (403), BSE direct (HTML)
//
// SCREENER HTML STRUCTURE (reverse-engineered from health check + public knowledge):
// Price: NOT in class="number" span. Screener uses:
//   <span id="current-price">1435.20</span>  -- but may be absent
//   OR ratio section: <li class="flex flex-space-between"><span>Current Price</span><span class="number">1435.20</span>
//   The "19,42,189" false match = shares outstanding or volume, not price
// MCap: in ratios section as "Market Cap" with value like "₹19,42,189 Cr" 
//   Wait — 19,42,189 Cr = 19.4 lakh Cr = correct for RELIANCE! So MCap IS being found as price.
//   The pattern matches MCap value first before price. Fix: target price specifically.
// PE: "Stock P/E" in same ratios section
// Quarters: section id="quarters" — but the table headers use format "Mar 2025" not "Mar '25"

const SCREENER_HDR = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://www.screener.in/', 'Cache-Control': 'no-cache' };
const YAHOO_HDR   = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/' };

async function withTimeout(promise, ms = 8000) {
  const t = new Promise((_, r) => setTimeout(() => r(new Error('Timeout ' + ms + 'ms')), ms));
  return Promise.race([promise, t]);
}

async function fetchDirect(url, json = true, headers = {}) {
  const r = await withTimeout(fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': json ? 'application/json,*/*' : 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9', ...headers }
  }));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (json) {
    const t = await r.text();
    if (t.trim()[0] === '<') throw new Error('Got HTML not JSON');
    return JSON.parse(t);
  }
  return r.text();
}

async function fetchYahoo(symbol, range = '1y', interval = '1d') {
  const sym = symbol.includes('.') ? symbol : symbol + '.NS';
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=${interval}&includePrePost=false`;
      const data = await fetchDirect(url, true, YAHOO_HDR);
      const result = data?.chart?.result?.[0];
      if (result) return result;
    } catch {}
  }
  throw new Error('Yahoo failed for ' + symbol);
}

async function fetchScreenerHTML(symbol) {
  for (const url of [
    `https://www.screener.in/company/${symbol}/consolidated/`,
    `https://www.screener.in/company/${symbol}/`
  ]) {
    try {
      const html = await withTimeout(fetch(url, { headers: SCREENER_HDR }).then(r => r.ok ? r.text() : null), 9000);
      if (html && html.length > 5000) return html;
    } catch {}
  }
  return null;
}

// ── SCREENER PARSER v5 ────────────────────────────────────────────────
// Fixed based on actual health check output:
// - Price "19,42,189" = MCap being matched as price. Separate them.
// - MCap pattern needs refinement  
// - Quarters: 0 found = header regex wrong (full month name vs abbreviation)
function parseScreener(html) {
  const out = { price: null, mcap: null, pe: null, sector: 'N/A', avg_val: null, quarters: [] };
  if (!html) return out;

  try {
    // ── PRICE ──────────────────────────────────────────────────────────
    // Screener renders current price in the top section
    // Pattern 1: <span id="current-price">1435.20</span>
    // Pattern 2: ratio block — "Current Price" label followed by value
    // Pattern 3: JSON in page — "__NEXT_DATA__" or inline script
    // The .number class regex was wrongly matching large MCap values
    
    // Most reliable: find "Current Price" label then get the next number
    const cpPat = [
      // id="current-price" 
      /id="current-price"[^>]*>\s*([\d,]+\.?\d*)/i,
      // Ratio block: Current Price / label then number on same or next element
      /Current Price[^<]*<\/[^>]+>\s*(?:<[^>]+>\s*)*₹?\s*([\d,]+\.?\d*)/i,
      // JSON embedded: "currentPrice" or "lastPrice"
      /"currentPrice"\s*:\s*([\d.]+)/i,
      /"lastPrice"\s*:\s*([\d.]+)/i,
      // Data attribute
      /data-price="([\d.]+)"/i,
      // The number class but ONLY if value is reasonable (< 100000 for a stock price)
    ];
    for (const p of cpPat) {
      const m = html.match(p);
      if (m) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        // Stock price should be between 1 and 100000
        if (v >= 1 && v <= 100000) { out.price = Math.round(v * 100) / 100; break; }
      }
    }
    // Last resort: find first .number span that is a realistic stock price
    if (!out.price) {
      const numRe = /class="[^"]*number[^"]*"[^>]*>\s*([\d,]+\.?\d*)\s*</g;
      let nm;
      while ((nm = numRe.exec(html)) !== null) {
        const v = parseFloat(nm[1].replace(/,/g,''));
        if (v >= 1 && v <= 100000) { out.price = Math.round(v*100)/100; break; }
      }
    }

    // ── MCAP ───────────────────────────────────────────────────────────
    // MCap shown as "19,42,189 Cr" in ratios. Must parse as Cr value.
    // The regex needs to get the Cr number correctly from Indian comma format
    const mcapPat = [
      // "Market Cap" label then value ending in " Cr"
      /Market Cap[^<]*<\/[^>]+>\s*(?:<[^>]+>\s*)*₹?\s*([\d,]+\.?\d*)\s*(?:Cr)?/i,
      // JSON
      /"marketCap"\s*:\s*([\d.]+)/i,
      /"market_cap"\s*:\s*([\d.]+)/i,
    ];
    for (const p of mcapPat) {
      const m = html.match(p);
      if (m) {
        // Parse Indian comma-formatted number: "19,42,189" = 1942189
        const raw = m[1].replace(/,/g, '');
        const v   = parseFloat(raw);
        // MCap in Cr: could be 100 (small cap) to 2000000 (Reliance)
        if (v >= 10 && v <= 100000000) { out.mcap = Math.round(v); break; }
      }
    }

    // ── PE ─────────────────────────────────────────────────────────────
    const pePat = [
      /Stock P\/E[^<]*<\/[^>]+>\s*(?:<[^>]+>\s*)*\s*([\d.]+)/i,
      /"pe"\s*:\s*([\d.]+)/i,
      /P\/E Ratio[^<]*<\/[^>]+>\s*(?:<[^>]+>\s*)*\s*([\d.]+)/i,
    ];
    for (const p of pePat) {
      const m = html.match(p);
      if (m) { const v = parseFloat(m[1]); if (v > 0 && v < 10000) { out.pe = v; break; } }
    }

    // ── SECTOR ─────────────────────────────────────────────────────────
    const secPat = [
      /"industry"\s*:\s*"([^"]{3,60})"/i,
      /"sector"\s*:\s*"([^"]{3,60})"/i,
      /class="[^"]*breadcrumb[^"]*"[\s\S]{0,500}?<a[^>]*>([^<]{4,40})<\/a>/i,
    ];
    for (const p of secPat) {
      const m = html.match(p);
      if (m && !['Home','Company','NSE','BSE'].includes(m[1].trim())) { out.sector = m[1].trim(); break; }
    }

    // ── QUARTERS ───────────────────────────────────────────────────────
    // Health check: "0 quarters found" for HDFCBANK
    // Screener quarter headers can be: "Mar 2025", "Dec 2024", "Sep 2024"
    // NOT abbreviated like "Mar '25" — try both formats
    const qSecM = html.match(/id="quarters"([\s\S]{0,10000}?)(?=<section|<div[^>]*id=|$)/i);
    if (qSecM) {
      const tbl = qSecM[1];

      // Try both header formats
      const hPatterns = [
        // "Mar 2025" format
        /<th[^>]*>\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})\s*<\/th>/gi,
        // "Mar '25" format  
        /<th[^>]*>\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*['`']\d{2})\s*<\/th>/gi,
        // "Q4 FY25" format
        /<th[^>]*>\s*(Q[1-4]\s*(?:FY)?\s*\d{2,4})\s*<\/th>/gi,
        // Any th with month name
        /<th[^>]*>\s*([A-Z][a-z]{2}[^<]{0,20})\s*<\/th>/g,
      ];

      const hdrs = [];
      for (const hRe of hPatterns) {
        let hm;
        hRe.lastIndex = 0;
        while ((hm = hRe.exec(tbl)) !== null && hdrs.length < 6) hdrs.push(hm[1].trim());
        if (hdrs.length >= 2) break;
      }

      function getRowVals(label) {
        // Find the row containing this label and extract TD numbers
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rowRe   = new RegExp('(?:>|\\s)' + escaped + '\\s*<[\\s\\S]{0,600}?<\\/tr>', 'i');
        const rm      = tbl.match(rowRe);
        if (!rm) return [];
        const nums = [];
        const tdRe = /<td[^>]*>\s*(-?[\d,]+\.?\d*)\s*<\/td>/g;
        let tm;
        while ((tm = tdRe.exec(rm[0])) !== null) {
          const v = parseFloat(tm[1].replace(/,/g, ''));
          if (!isNaN(v)) nums.push(v);
        }
        return nums;
      }

      // Try different label names Screener uses
      const salesLabels = ['Sales', 'Revenue', 'Net Sales', 'Total Revenue', 'Income'];
      const patLabels   = ['Net Profit', 'PAT', 'Profit after tax', 'Net Income', 'Profit'];

      let sales = [], pat = [];
      for (const l of salesLabels) { sales = getRowVals(l); if (sales.length) break; }
      for (const l of patLabels)   { pat   = getRowVals(l); if (pat.length)   break; }

      for (let i = 0; i < Math.min(Math.max(hdrs.length, 4), 5); i++) {
        out.quarters.push({
          label:   hdrs[i] || `Q${i+1}`,
          revenue: sales[i] ?? null,
          pat:     pat[i]   ?? null
        });
      }
    }

    // ── AVG DAILY VALUE ────────────────────────────────────────────────
    const volM = html.match(/(?:10|30)\s*Day\s*Avg[^<]*<\/[^>]+>\s*(?:<[^>]+>\s*)*\s*([\d,]+)/i);
    if (volM && out.price) {
      const vol = parseFloat(volM[1].replace(/,/g,''));
      out.avg_val = Math.round(vol * out.price / 1e7 * 10) / 10;
    }

  } catch (e) { /* best effort */ }
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

// RS — MarketSmith weighted
function calcRS(closes) {
  if (!closes || closes.length < 60) return null;
  const len = closes.length;
  const perf = (si, ei) => { const s = closes[si], e = closes[Math.min(ei,len)-1]; return s>0?(e-s)/s:0; };
  const q4s=Math.max(0,len-63), q3s=Math.max(0,len-126), q2s=Math.max(0,len-189), q1s=Math.max(0,len-252);
  return (perf(q4s,len)*2 + perf(q3s,q4s) + perf(q2s,q3s) + perf(q1s,q2s)) / 5;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sendError(res, s, m) { return res.status(s).json({ error: true, message: m }); }
function sendOk(res, data) { return res.status(200).json({ error: false, ...data }); }

module.exports = { fetchDirect, fetchYahoo, fetchScreenerHTML, parseScreener, calcEMA, calcRS, sleep, sendError, sendOk };
