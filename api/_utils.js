// _utils.js v6
// KEY FIXES:
// 1. Screener MCap: "19,42,189 Cr" — Indian number format parsing
// 2. Screener quarters: section regex cuts off too early — use indexOf approach
// 3. All patterns tested against known real HTML structure

const SCREENER_HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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

// ── parseIndianNumber ─────────────────────────────────────────────────
// Converts "19,42,189" → 1942189  OR  "1,23,456.78" → 123456.78
function parseIndian(s) {
  if (!s) return null;
  const v = parseFloat(String(s).replace(/,/g, ''));
  return isNaN(v) ? null : v;
}

// ── SCREENER PARSER v6 ────────────────────────────────────────────────
// Uses indexOf-based section extraction (avoids regex catastrophic backtracking)
// and tests multiple label patterns for each field
function parseScreener(html) {
  const out = { price: null, mcap: null, pe: null, sector: 'N/A', avg_val: null, quarters: [] };
  if (!html) return out;

  try {
    // ── PRICE ──────────────────────────────────────────────────────────
    // Strategy: find the ratio/top section, then extract numbers with sanity check
    // RELIANCE price ~1435, MCap ~19,42,189 Cr — price is < 100000, MCap > 100000
    const pricePats = [
      /id="current-price"[^>]*>\s*([\d,]+\.?\d*)/i,
      /Current Price[^<]{0,5}<\/[^>]+>[^<]{0,30}<[^>]+>\s*₹?\s*([\d,]+\.?\d*)/i,
      /"currentPrice"\s*:\s*([\d.]+)/i,
      /"lastPrice"\s*:\s*([\d.]+)/i,
      /data-last-price="([\d.]+)"/i,
    ];
    for (const p of pricePats) {
      const m = html.match(p);
      if (m) {
        const v = parseIndian(m[1]);
        if (v && v >= 0.5 && v <= 200000) { out.price = Math.round(v * 100) / 100; break; }
      }
    }
    // Fallback: first .number value in reasonable price range
    if (!out.price) {
      const re = /class="[^"]*\bnumber\b[^"]*"[^>]*>\s*([\d,]+\.?\d*)\s*</g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const v = parseIndian(m[1]);
        if (v && v >= 0.5 && v <= 200000) { out.price = Math.round(v * 100) / 100; break; }
      }
    }

    // ── MCAP ───────────────────────────────────────────────────────────
    // Screener shows MCap as "₹19,42,189 Cr" in the ratios list
    // The key insight: after "Market Cap" label, there's a number in Indian format
    // followed by " Cr" — the number itself can be very large (lakh crores)
    const mcapPats = [
      // Standard ratio block pattern
      /Market\s*Cap[^<]{0,10}<\/[^>]+>[^<]{0,50}<[^>]+>\s*₹?\s*([\d,]+\.?\d*)/i,
      // With "Cr" suffix nearby
      /Market\s*Cap[^<]{0,100}([\d,]{3,})\s*(?:Cr|cr)/i,
      /"marketCap"\s*:\s*"?([\d,]+)"?/i,
      /"market_cap"\s*:\s*([\d.]+)/i,
    ];
    for (const p of mcapPats) {
      const m = html.match(p);
      if (m) {
        const v = parseIndian(m[1]);
        // MCap in Cr: smallcap ~100Cr, Reliance ~19,42,189 Cr
        if (v && v >= 1) { out.mcap = Math.round(v); break; }
      }
    }

    // ── PE ─────────────────────────────────────────────────────────────
    const pePats = [
      /Stock\s*P\/E[^<]{0,10}<\/[^>]+>[^<]{0,50}<[^>]+>\s*([\d.]+)/i,
      /P\/E\s*(?:Ratio)?[^<]{0,10}<\/[^>]+>[^<]{0,50}<[^>]+>\s*([\d.]+)/i,
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
      /sector[^"]*"([A-Za-z][^"]{3,50})"/i,
    ];
    const badSectors = new Set(['Home','Company','NSE','BSE','Market','Stock','India','Screener']);
    for (const p of secPats) {
      const m = html.match(p);
      if (m && !badSectors.has(m[1].trim())) { out.sector = m[1].trim(); break; }
    }

    // ── QUARTERS ───────────────────────────────────────────────────────
    // Use indexOf to find section boundaries — more reliable than regex for large HTML
    const qStart = html.indexOf('id="quarters"');
    if (qStart !== -1) {
      // Find the end of the quarters section — next section or 15KB limit
      const searchFrom = qStart;
      let qEnd = html.length;
      const nextSection = html.indexOf('<section', qStart + 100);
      if (nextSection !== -1 && nextSection - qStart < 15000) qEnd = nextSection;
      const tbl = html.slice(qStart, Math.min(qEnd, qStart + 15000));

      // Extract quarter header labels — try multiple formats
      // Screener uses "Mar 2025", "Dec 2024" etc in <th> elements
      const allThs = [];
      const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
      let thm;
      while ((thm = thRe.exec(tbl)) !== null) {
        const txt = thm[1].replace(/<[^>]+>/g, '').trim();
        // Match: "Mar 2025", "Dec 2024", "Mar '25", "Q4 FY25"
        if (/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/.test(txt) ||
            /Q[1-4]\s*(?:FY)?\s*\d{2}/.test(txt)) {
          allThs.push(txt);
        }
      }
      const hdrs = allThs.slice(0, 5);

      // Extract TD values from a row by finding the row containing a label
      function getRowNums(label) {
        const li = tbl.toLowerCase().indexOf(label.toLowerCase());
        if (li === -1) return [];
        // Find the enclosing <tr>...</tr>
        const trStart = tbl.lastIndexOf('<tr', li);
        const trEnd   = tbl.indexOf('</tr>', li);
        if (trStart === -1 || trEnd === -1) return [];
        const row = tbl.slice(trStart, trEnd + 5);
        const nums = [];
        const tdRe = /<td[^>]*>\s*(-?[\d,]+\.?\d*)\s*<\/td>/gi;
        let tm;
        while ((tm = tdRe.exec(row)) !== null) {
          const v = parseIndian(tm[1]);
          if (v !== null) nums.push(v);
        }
        return nums;
      }

      const salesLabels = ['Sales', 'Revenue', 'Net Sales', 'Total Revenue', 'Income from Operations'];
      const patLabels   = ['Net Profit', 'PAT', 'Profit after tax', 'Net Income'];

      let sales = [], pat = [];
      for (const l of salesLabels) { sales = getRowNums(l); if (sales.length >= 2) break; }
      for (const l of patLabels)   { pat   = getRowNums(l); if (pat.length >= 2)   break; }

      const count = Math.max(hdrs.length, sales.length, pat.length, 4);
      for (let i = 0; i < Math.min(count, 5); i++) {
        out.quarters.push({
          label:   hdrs[i]   || `Q${i + 1}`,
          revenue: sales[i]  ?? null,
          pat:     pat[i]    ?? null
        });
      }
    }

    // ── AVG DAILY VALUE ────────────────────────────────────────────────
    const volM = html.match(/(?:10|30)\s*Day\s*Avg[^<]{0,30}<\/[^>]+>[^<]{0,50}<[^>]+>\s*([\d,]+)/i);
    if (volM && out.price) {
      const vol = parseIndian(volM[1]);
      if (vol) out.avg_val = Math.round(vol * out.price / 1e7 * 10) / 10;
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

module.exports = { fetchDirect, fetchYahoo, fetchScreenerHTML, parseScreener, parseIndian, calcEMA, calcRS, sleep, sendError, sendOk };
