// api/health.js — self-diagnosing health check for all data sources
// Visit /api/health to see live status of every source used by the scanner
// Returns detailed per-source latency, HTTP status, sample data shape
// NO manual debugging needed — this tells you exactly what's working

const { sleep } = require('./_utils');

async function checkSource(name, url, headers, validator) {
  const start = Date.now();
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    const latency = Date.now() - start;
    if (!r.ok) return { name, status: 'ERROR', http: r.status, latency, detail: 'HTTP ' + r.status };
    let body;
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('json')) body = await r.json();
    else { const txt = await r.text(); body = txt.slice(0, 500); }
    const validation = validator ? validator(body) : { ok: true };
    return {
      name,
      status: validation.ok ? 'OK' : 'WARN',
      http: r.status,
      latency,
      detail: validation.detail || 'Response received',
      sample: validation.sample || null
    };
  } catch (e) {
    return { name, status: 'ERROR', http: 0, latency: Date.now() - start, detail: e.message };
  }
}

async function getNSECookie() {
  try {
    const r = await fetch('https://www.nseindia.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html' },
      signal: AbortSignal.timeout(6000)
    });
    const sc = r.headers.get('set-cookie') || '';
    return sc.split(',').map(c => c.split(';')[0].trim()).filter(c => c.includes('=')).join('; ');
  } catch { return ''; }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ck = await getNSECookie();
  const NSE_H = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.nseindia.com/',
    'Cookie': ck
  };

  // Run all checks in parallel
  const checks = await Promise.all([

    // ── NSE Session ──────────────────────────────────────────────
    checkSource(
      'NSE Session Cookie',
      'https://www.nseindia.com',
      { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
      body => ({ ok: typeof body === 'string' && body.length > 100, detail: 'Cookie: ' + (ck ? ck.slice(0,40)+'...' : 'NONE') })
    ),

    // ── NSE Nifty 500 CSV ─────────────────────────────────────────
    checkSource(
      'NSE Nifty500 CSV',
      'https://archives.nseindia.com/content/indices/ind_nifty500list.csv',
      { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.nseindia.com/', 'Accept': 'text/csv' },
      body => {
        const lines = (body || '').split('\n').filter(Boolean);
        const ok = lines.length > 400;
        const sample = ok ? lines[1]?.slice(0,80) : 'Too few lines: ' + lines.length;
        return { ok, detail: lines.length + ' rows', sample };
      }
    ),

    // ── NSE Gainers ───────────────────────────────────────────────
    checkSource(
      'NSE Live Gainers',
      'https://www.nseindia.com/api/live-analysis-variations?index=gainers&type=securities',
      NSE_H,
      body => {
        const arr = Array.isArray(body) ? body
          : Array.isArray(body?.data) ? body.data
          : Array.isArray(body?.Securities) ? body.Securities
          : null;
        if (!arr) return { ok: false, detail: 'Unexpected shape. Keys: ' + Object.keys(body||{}).join(',') };
        return { ok: arr.length > 0, detail: arr.length + ' securities', sample: JSON.stringify(arr[0]).slice(0,120) };
      }
    ),

    // ── NSE Corporate Announcements ───────────────────────────────
    checkSource(
      'NSE Corporate Results',
      'https://www.nseindia.com/api/corporate-announcements?index=equities&subject=Financial+Results',
      NSE_H,
      body => {
        const arr = Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data : null);
        if (!arr) return { ok: false, detail: 'Unexpected shape. Keys: ' + Object.keys(body||{}).join(',') };
        return { ok: arr.length > 0, detail: arr.length + ' announcements', sample: JSON.stringify(arr[0]).slice(0,120) };
      }
    ),

    // ── NSE IPO / New Listings ────────────────────────────────────
    checkSource(
      'NSE New Listings',
      'https://www.nseindia.com/api/market-data-pre-open?key=NEWLISTING&type=EQ',
      NSE_H,
      body => {
        const arr = Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data : null);
        if (!arr) return { ok: false, detail: 'Unexpected shape. Keys: ' + Object.keys(body||{}).join(',') };
        return { ok: true, detail: arr.length + ' items', sample: JSON.stringify(arr[0]).slice(0,120) };
      }
    ),

    // ── Screener.in ───────────────────────────────────────────────
    checkSource(
      'Screener.in (RELIANCE)',
      'https://www.screener.in/company/RELIANCE/consolidated/',
      { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html', 'Referer': 'https://www.screener.in/' },
      body => {
        const hasPrice = /id="current-price"/.test(body);
        const hasMcap = /Market Cap/.test(body);
        const hasPE = /Stock P\/E/.test(body);
        const hasQuarters = /id="quarters"/.test(body);
        return {
          ok: hasPrice && hasMcap,
          detail: [
            hasPrice ? '✓ price' : '✗ price',
            hasMcap  ? '✓ mcap'  : '✗ mcap',
            hasPE    ? '✓ PE'    : '✗ PE',
            hasQuarters ? '✓ quarters' : '✗ quarters'
          ].join(' | ')
        };
      }
    ),

    // ── Yahoo Finance ─────────────────────────────────────────────
    checkSource(
      'Yahoo Finance (RELIANCE.NS)',
      'https://query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS?range=5d&interval=1d&includePrePost=false',
      { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/' },
      body => {
        const result = body?.chart?.result?.[0];
        if (!result) return { ok: false, detail: 'No chart result. Error: ' + JSON.stringify(body?.chart?.error) };
        const closes = result.indicators?.quote?.[0]?.close?.filter(c => c != null);
        return {
          ok: closes?.length > 0,
          detail: closes?.length + ' closes',
          sample: 'Latest close: ' + closes?.[closes.length-1]
        };
      }
    ),

    // ── Trendlyne ─────────────────────────────────────────────────
    checkSource(
      'Trendlyne Results Page',
      'https://trendlyne.com/equity/latest-quarterly-results/',
      { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html', 'Referer': 'https://trendlyne.com/' },
      body => {
        const hasData = /data-symbol=|quarterly|result/i.test(body||'');
        return { ok: typeof body === 'string' && body.length > 1000, detail: hasData ? 'Has result data' : 'Page loaded but no result data found', sample: null };
      }
    ),

    // ── Moneycontrol ──────────────────────────────────────────────
    checkSource(
      'Moneycontrol Results Calendar',
      'https://www.moneycontrol.com/markets/earnings/results-calendar/',
      { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html', 'Referer': 'https://www.moneycontrol.com/' },
      body => {
        const hasNse = /data-nse_code|NSE:/i.test(body||'');
        return { ok: typeof body === 'string' && body.length > 500, detail: hasNse ? 'NSE codes found' : 'Page loaded, no NSE codes detected' };
      }
    ),

  ]);

  // Summary counts
  const ok    = checks.filter(c => c.status === 'OK').length;
  const warn  = checks.filter(c => c.status === 'WARN').length;
  const error = checks.filter(c => c.status === 'ERROR').length;

  const overallStatus = error > 3 ? 'DEGRADED' : error > 0 ? 'PARTIAL' : 'HEALTHY';

  // Scan-level diagnosis: which scans are affected
  const scanStatus = {
    'Scan 1 (Earnings)': [
      checks.find(c => c.name === 'NSE Corporate Results'),
      checks.find(c => c.name === 'Screener.in (RELIANCE)'),
      checks.find(c => c.name === 'Trendlyne Results Page')
    ],
    'Scan 2 (RS)': [
      checks.find(c => c.name === 'NSE Nifty500 CSV'),
      checks.find(c => c.name === 'Yahoo Finance (RELIANCE.NS)')
    ],
    'Scan 3 (Gainers)': [
      checks.find(c => c.name === 'NSE Live Gainers'),
      checks.find(c => c.name === 'Yahoo Finance (RELIANCE.NS)')
    ],
    'Scan 4 (IPO)': [
      checks.find(c => c.name === 'NSE New Listings'),
      checks.find(c => c.name === 'Screener.in (RELIANCE)')
    ]
  };

  const scanReport = {};
  for (const [scan, sources] of Object.entries(scanStatus)) {
    const allOk  = sources.every(s => s?.status === 'OK');
    const anyOk  = sources.some(s => s?.status === 'OK');
    scanReport[scan] = allOk ? '✅ All sources OK'
      : anyOk ? '⚠️ Partial — some sources down, fallbacks may activate'
      : '❌ All sources down — scan will fail';
  }

  res.status(200).json({
    overall: overallStatus,
    summary: { ok, warn, error, total: checks.length },
    scan_status: scanReport,
    sources: checks,
    timestamp: new Date().toISOString(),
    note: 'Visit /api/health after each deployment to verify all sources are reachable from Vercel servers.'
  });
};
