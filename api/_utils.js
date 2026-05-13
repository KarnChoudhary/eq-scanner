// _utils.js v7
// ROOT CAUSE FIXES (confirmed by testing):
// 1. MCap: Screener wraps value in nested <span> inside .number span
//    Fix: find 'Market Cap' then grab first >NNNN< pattern after it
// 2. Quarters: Screener uses single quotes id='quarters' not double quotes
//    Fix: search for BOTH quote styles with findSectionId()

const SCREENER_HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.screener.in/',
  'Cache-Control': 'no-cache'
};

async function withTimeout(promise, ms = 9000) {
  const t = new Promise((_, r) => setTimeout(() => r(new Error('Timeout ' + ms + 'ms')), ms));
  return Promise.race([promise, t]);
}

async function fetchDirect(url, json = true, headers = {}) {
  const r = await withTimeout(fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': json ? 'application/json,*/*' : 'text/html,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...headers
    }
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
      const data = await fetchDirect(url, true, { 'Referer': 'https://finance.yahoo.com/' });
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
      const html = await withTimeout(
        fetch(url, { headers: SCREENER_HDR }).then(r => r.ok ? r.text() : null),
        9500
      );
      if (html && html.length > 5000) return html;
    } catch {}
  }
  return null;
}

// Find section by id — handles BOTH single and double quote attribute values
function findSectionId(html, id) {
  let idx = html.indexOf('id="' + id + '"');
  if (idx === -1) idx = html.indexOf("id='" + id + "'");
  return idx;
}

// Parse Indian comma-formatted number: "19,42,189" → 1942189
function parseIndian(s) {
  if (!s) return null;
  const v = parseFloat(String(s).replace(/,/g, ''));
  return isNaN(v) ? null : v;
}

// ── SCREENER PARSER v7 ────────────────────────────────────────────────
function parseScreener(html) {
  const out = { price: null, mcap: null, pe: null, sector: 'N/A', avg_val: null, quarters: [] };
  if (!html) return out;

  try {
    // ── PRICE ──────────────────────────────────────────────────────────
    // Screener puts current price in top section
    // Pattern: <span id="current-price">1388</span> OR ratio list value
    const pricePats = [
      /id=["']current-price["'][^>]*>\s*([\d,]+\.?\d*)/i,
      /Current Price[^<]{0,10}<\/[^>]+>[^<]{0,100}<[^>]+>\s*₹?\s*([\d,]+\.?\d*)/i,
      /"currentPrice"\s*:\s*([\d.]+)/i,
      /"lastPrice"\s*:\s*([\d.]+)/i,
    ];
    for (const p of pricePats) {
      const m = html.match(p);
      if (m) {
        const v = parseIndian(m[1]);
        if (v && v >= 0.5 && v <= 200000) { out.price = Math.round(v * 100) / 100; break; }
      }
    }
    // Fallback: first .number value in price range, skipping large MCap values
    if (!out.price) {
      const re = /class=["'][^"']*\bnumber\b[^"']*["'][^>]*>\s*([\d,]+\.?\d*)\s*</g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const v = parseIndian(m[1]);
        if (v && v >= 0.5 && v <= 200000) { out.price = Math.round(v * 100) / 100; break; }
      }
    }

    // ── MCAP ───────────────────────────────────────────────────────────
    // FIX: Screener nests value in <span><span>19,42,189</span></span>
    // Strategy: find 'Market Cap', grab first >DIGITS< pattern after it
    const mcapIdx = html.indexOf('Market Cap');
    if (mcapIdx !== -1) {
      const snippet = html.slice(mcapIdx, mcapIdx + 500);
      // Match first occurrence of >number< where number has 4+ digits
      const numM = snippet.match(/>(\d[\d,]{3,}(?:\.\d+)?)</);
      if (numM) {
        const v = parseIndian(numM[1]);
        if (v && v >= 1) out.mcap = Math.round(v);
      }
    }
    // Fallback JSON patterns
    if (!out.mcap) {
      const jsonPats = [/"marketCap"\s*:\s*"?([\d,]+)"?/i, /"market_cap"\s*:\s*([\d.]+)/i];
      for (const p of jsonPats) {
        const m = html.match(p);
        if (m) { const v = parseIndian(m[1]); if (v && v >= 1) { out.mcap = Math.round(v); break; } }
      }
    }

    // ── PE ─────────────────────────────────────────────────────────────
    const pePats = [
      /Stock\s*P\/E[^<]{0,10}<\/[^>]+>[^<]{0,100}<[^>]+>\s*([\d.]+)/i,
      /"stockPE"\s*:\s*([\d.]+)/i,
      /"pe"\s*:\s*([\d.]+)/i,
    ];
    for (const p of pePats) {
      const m = html.match(p);
      if (m) { const v = parseFloat(m[1]); if (v > 0 && v < 50000) { out.pe = Math.round(v * 10) / 10; break; } }
    }

    // ── SECTOR ─────────────────────────────────────────────────────────
    const secPats = [
      /"industry"\s*:\s*"([^"]{3,60})"/i,
      /"sector"\s*:\s*"([^"]{3,60})"/i,
    ];
    const badSec = new Set(['Home', 'Company', 'NSE', 'BSE', 'Market', 'Stock', 'India', 'Screener', 'N/A']);
    for (const p of secPats) {
      const m = html.match(p);
      if (m && !badSec.has(m[1].trim())) { out.sector = m[1].trim(); break; }
    }

    // ── QUARTERS ───────────────────────────────────────────────────────
    // FIX: Use findSectionId() which handles both single AND double quotes
    const qIdx = findSectionId(html, 'quarters');
    if (qIdx !== -1) {
      // Find end of section — next section boundary
      let qEnd = html.length;
      // Look for next <section or <div id= after start
      const patterns = ['<section', '<div id=', "<div id='"];
      for (const p of patterns) {
        const ni = html.indexOf(p, qIdx + 200);
        if (ni !== -1 && ni < qEnd) qEnd = ni;
      }
      const tbl = html.slice(qIdx, Math.min(qEnd, qIdx + 20000));

      // Extract quarter header labels from <th> elements
      const hdrs = [];
      const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
      let thm;
      while ((thm = thRe.exec(tbl)) !== null) {
        const txt = thm[1].replace(/<[^>]+>/g, '').trim();
        if (/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/.test(txt) ||
            /Q[1-4]\s*(?:FY)?\s*\d{2}/.test(txt)) {
          hdrs.push(txt);
        }
      }

      // Extract TD numbers from a row by label
      function getRowNums(label) {
        const li = tbl.toLowerCase().indexOf(label.toLowerCase());
        if (li === -1) return [];
        const trS = tbl.lastIndexOf('<tr', li);
        const trE = tbl.indexOf('</tr>', li);
        if (trS === -1 || trE === -1) return [];
        const row = tbl.slice(trS, trE + 5);
        const nums = [];
        const tdRe = /<td[^>]*>\s*(-?[\d,]+\.?\d*)\s*<\/td>/gi;
        let tm;
        while ((tm = tdRe.exec(row)) !== null) {
          const v = parseIndian(tm[1]);
          if (v !== null) nums.push(v);
        }
        return nums;
      }

      const salesLabels = ['Sales +', 'Sales', 'Revenue', 'Net Sales', 'Total Revenue', 'Income from Operations'];
      const patLabels   = ['Net Profit +', 'Net Profit', 'PAT', 'Profit after tax', 'Net Income'];

      let sales = [], pat = [];
      for (const l of salesLabels) { sales = getRowNums(l); if (sales.length >= 2) break; }
      for (const l of patLabels)   { pat   = getRowNums(l); if (pat.length >= 2)   break; }

      // Build quarters array — use max of headers/data length up to 5
      const count = Math.min(Math.max(hdrs.length, sales.length, pat.length), 5);
      for (let i = 0; i < count; i++) {
        out.quarters.push({
          label:   hdrs[i]  || `Q${i + 1}`,
          revenue: sales[i] != null ? sales[i] : null,
          pat:     pat[i]   != null ? pat[i]   : null
        });
      }
    }

    // ── AVG DAILY VALUE ────────────────────────────────────────────────
    const volIdx = html.search(/(?:10|30)\s*Day\s*Avg/i);
    if (volIdx !== -1 && out.price) {
      const snippet = html.slice(volIdx, volIdx + 300);
      const numM = snippet.match(/>(\d[\d,]*)</);
      if (numM) {
        const vol = parseIndian(numM[1]);
        if (vol) out.avg_val = Math.round(vol * out.price / 1e7 * 10) / 10;
      }
    }

  } catch (e) { /* best effort */ }
  return out;
}

function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return Math.round(ema * 100) / 100;
}

function calcRS(closes) {
  if (!closes || closes.length < 60) return null;
  const len = closes.length;
  const perf = (si, ei) => { const s = closes[si], e = closes[Math.min(ei, len) - 1]; return s > 0 ? (e - s) / s : 0; };
  const q4s = Math.max(0, len - 63), q3s = Math.max(0, len - 126),
        q2s = Math.max(0, len - 189), q1s = Math.max(0, len - 252);
  return (perf(q4s, len) * 2 + perf(q3s, q4s) + perf(q2s, q3s) + perf(q1s, q2s)) / 5;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sendError(res, s, m) { return res.status(s).json({ error: true, message: m }); }
function sendOk(res, data) { return res.status(200).json({ error: false, ...data }); }

module.exports = { fetchDirect, fetchYahoo, fetchScreenerHTML, parseScreener, parseIndian, findSectionId, calcEMA, calcRS, sleep, sendError, sendOk };
