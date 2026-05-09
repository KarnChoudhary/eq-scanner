// health.js v4 — tests only confirmed-working sources
const { fetchDirect, fetchYahoo } = require('./_utils');

async function chk(name, fn) {
  const start = Date.now();
  try {
    const result = await Promise.race([
      fn(),
      new Promise((_,r) => setTimeout(() => r(new Error('Timeout 8s')), 8000))
    ]);
    return { name, status: result.ok ? 'OK' : 'WARN', latency: Date.now()-start, detail: result.detail, sample: result.sample||null };
  } catch (e) {
    return { name, status: 'ERROR', latency: Date.now()-start, detail: e.message, sample: null };
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const checks = await Promise.all([

    chk('Yahoo Finance (RELIANCE.NS)', async () => {
      const r = await fetchYahoo('RELIANCE', '5d', '1d');
      const closes = r?.indicators?.quote?.[0]?.close?.filter(c => c != null);
      return { ok: closes?.length > 0, detail: closes?.length + ' closes. Latest: ₹' + closes?.[closes.length-1]?.toFixed(2) };
    }),

    chk('Yahoo Finance (TCS.NS)', async () => {
      const r = await fetchYahoo('TCS', '5d', '1d');
      const closes = r?.indicators?.quote?.[0]?.close?.filter(c => c != null);
      return { ok: closes?.length > 0, detail: closes?.length + ' closes. Latest: ₹' + closes?.[closes.length-1]?.toFixed(2) };
    }),

    chk('Screener.in — Price', async () => {
      const html = await fetchDirect('https://www.screener.in/company/RELIANCE/consolidated/', false, { 'Referer': 'https://www.screener.in/' });
      const prM = html.match(/<span[^>]*class="[^"]*number[^"]*"[^>]*>\s*([\d,]+\.?\d*)/);
      const mcM = html.match(/Market Cap[^<]*<\/[^>]+>\s*<[^>]+>\s*₹?\s*([\d,]+)/i);
      const peM = html.match(/Stock P\/E[^<]*<\/[^>]+>\s*<[^>]+>\s*([\d.]+)/i);
      const qM  = /id="quarters"/.test(html);
      return {
        ok: !!(mcM || peM),
        detail: [prM?'✓price ('+prM[1]+')':'✗price', mcM?'✓mcap':'✗mcap', peM?'✓PE':'✗PE', qM?'✓quarters':'✗quarters'].join(' | '),
        sample: 'Page size: ' + html.length + ' chars'
      };
    }),

    chk('Screener.in — Quarters', async () => {
      const html = await fetchDirect('https://www.screener.in/company/HDFCBANK/consolidated/', false, { 'Referer': 'https://www.screener.in/' });
      const qSec = html.match(/id="quarters"([\s\S]{0,3000})/i);
      const hRe  = /<th[^>]*>\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[^<]{0,10})<\/th>/gi;
      const hdrs = []; let hm;
      if (qSec) { while ((hm = hRe.exec(qSec[1])) !== null && hdrs.length < 4) hdrs.push(hm[1].trim()); }
      return { ok: hdrs.length >= 2, detail: hdrs.length + ' quarters found: ' + hdrs.join(', ') };
    }),

    chk('Moneycontrol — Calendar', async () => {
      const html = await fetchDirect('https://www.moneycontrol.com/markets/earnings/results-calendar/', false, { 'Referer': 'https://www.moneycontrol.com/' });
      // Try to find any JSON data in the page
      const jsonMatches = (html.match(/\{[^{}]{20,200}\}/g) || []).length;
      const scriptTags  = (html.match(/<script/g) || []).length;
      return { ok: html.length > 50000, detail: 'Page: ' + html.length + ' chars | ' + scriptTags + ' scripts | ' + jsonMatches + ' JSON blobs' };
    }),

    chk('Moneycontrol — API endpoint', async () => {
      const today = new Date().toISOString().slice(0,10);
      const past  = new Date(Date.now()-30*86400000).toISOString().slice(0,10);
      const url   = `https://api.moneycontrol.com/mcapi/v1/results/calendar?startDate=${past}&endDate=${today}&type=Q&exchange=NSE`;
      const data  = await fetchDirect(url, true, { 'Referer': 'https://www.moneycontrol.com/', 'Origin': 'https://www.moneycontrol.com' });
      const rows  = data?.data || data?.results || (Array.isArray(data) ? data : []);
      return { ok: rows.length > 0, detail: rows.length + ' results', sample: JSON.stringify(rows[0]||{}).slice(0,120) };
    }),

    chk('NSE Nifty500 CSV (corsproxy)', async () => {
      const url  = 'https://archives.nseindia.com/content/indices/ind_nifty500list.csv';
      const purl = 'https://corsproxy.io/?' + encodeURIComponent(url);
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 6000);
      const r    = await fetch(purl, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      if (text.trim().startsWith('<')) throw new Error('Got HTML — proxy blocked');
      const lines = text.split('\n').filter(l => l.trim());
      return { ok: lines.length > 100, detail: lines.length + ' rows', sample: lines[1]?.slice(0,80) };
    }),

    chk('corsproxy.io — general', async () => {
      const purl = 'https://corsproxy.io/?' + encodeURIComponent('https://httpbin.org/json');
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(purl, { signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      return { ok: !!data?.slideshow, detail: 'corsproxy.io is working' };
    }),

  ]);

  const ok    = checks.filter(c => c.status === 'OK').length;
  const warn  = checks.filter(c => c.status === 'WARN').length;
  const error = checks.filter(c => c.status === 'ERROR').length;
  const overall = error >= 3 ? 'DEGRADED' : error >= 1 ? 'PARTIAL' : 'HEALTHY';

  const byName = Object.fromEntries(checks.map(c => [c.name, c]));
  const scanStatus = {
    'Scan 1 (Earnings)':  [byName['Screener.in — Quarters'], byName['Moneycontrol — API endpoint'], byName['Moneycontrol — Calendar']],
    'Scan 2 (RS)':        [byName['Yahoo Finance (RELIANCE.NS)'], byName['NSE Nifty500 CSV (corsproxy)']],
    'Scan 3 (Gainers)':   [byName['Yahoo Finance (RELIANCE.NS)'], byName['Yahoo Finance (TCS.NS)']],
    'Scan 4 (IPO)':       [byName['Yahoo Finance (RELIANCE.NS)'], byName['Screener.in — Price']],
  };

  const scanReport = {};
  for (const [scan, sources] of Object.entries(scanStatus)) {
    const allOk = sources.every(s => s?.status === 'OK');
    const anyOk = sources.some(s => s?.status === 'OK');
    scanReport[scan] = allOk ? '✅ All sources OK' : anyOk ? '⚠️ Partial — some sources down' : '❌ All sources down';
  }

  res.status(200).json({ overall, summary:{ok,warn,error,total:checks.length}, scan_status: scanReport, sources: checks, timestamp: new Date().toISOString() });
};
