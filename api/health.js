// api/health.js v3 — updated for proxy-based architecture
const { fetchViaProxy, fetchDirect, fetchYahoo, sleep } = require('./_utils');

async function chk(name, fn) {
  const start = Date.now();
  try {
    const result = await Promise.race([fn(), new Promise((_,r) => setTimeout(() => r(new Error('Timeout 9s')), 9000))]);
    return { name, status: result.ok ? 'OK' : 'WARN', latency: Date.now()-start, detail: result.detail, sample: result.sample||null };
  } catch (e) {
    return { name, status: 'ERROR', latency: Date.now()-start, detail: e.message, sample: null };
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const checks = await Promise.all([

    chk('allorigins Proxy', async () => {
      const data = await fetchViaProxy('https://httpbin.org/json', true);
      return { ok: !!data, detail: data ? 'Proxy working' : 'Proxy returned empty' };
    }),

    chk('NSE Nifty500 CSV (via proxy)', async () => {
      const text = await fetchViaProxy('https://archives.nseindia.com/content/indices/ind_nifty500list.csv', false);
      const lines = text.split('\n').filter(l=>l.trim());
      return { ok: lines.length > 200, detail: lines.length + ' rows', sample: lines[1]?.slice(0,80) };
    }),

    chk('NSE Gainers allSec (via proxy)', async () => {
      const data = await fetchViaProxy('https://www.nseindia.com/api/live-analysis-variations?index=gainers&type=securities', true);
      const keys = Object.keys(data||{});
      const allSec = data?.allSec?.data || data?.allSec || [];
      return { ok: allSec.length > 0, detail: 'Keys: '+keys.join(',')+' | allSec: '+allSec.length, sample: JSON.stringify(allSec[0]||{}).slice(0,100) };
    }),

    chk('NSE Corporate Results (via proxy)', async () => {
      const data = await fetchViaProxy('https://www.nseindia.com/api/corporate-announcements?index=equities&subject=Financial+Results', true);
      const rows = Array.isArray(data) ? data : (data?.data||[]);
      return { ok: rows.length > 0, detail: rows.length+' announcements', sample: JSON.stringify(rows[0]||{}).slice(0,100) };
    }),

    chk('NSE New Listings (via proxy)', async () => {
      const data = await fetchViaProxy('https://www.nseindia.com/api/market-data-pre-open?key=NEWLISTING&type=EQ', true);
      const rows = Array.isArray(data)?data:(data?.data||[]);
      return { ok: true, detail: rows.length+' items. Keys: '+Object.keys(data||{}).slice(0,5).join(','), sample: JSON.stringify(rows[0]||{}).slice(0,100) };
    }),

    chk('BSE IPO Data (direct)', async () => {
      const today=new Date().toISOString().slice(0,10).replace(/-/g,'');
      const past=new Date(Date.now()-365*86400000).toISOString().slice(0,10).replace(/-/g,'');
      const data = await fetchDirect(`https://api.bseindia.com/BseIndiaAPI/api/IPODetails/w?strDate=${past}&endDate=${today}&status=listed`, true, {'Referer':'https://www.bseindia.com/'});
      const rows = data?.Table||data?.data||data||[];
      return { ok: Array.isArray(rows), detail: Array.isArray(rows)?rows.length+' IPOs':'Unexpected shape', sample: JSON.stringify((Array.isArray(rows)?rows[0]:{})||{}).slice(0,100) };
    }),

    chk('Screener.in (RELIANCE)', async () => {
      const html = await fetchDirect('https://www.screener.in/company/RELIANCE/consolidated/', false, {'Referer':'https://www.screener.in/'});
      const hasPrice = /id="current-price"|current_price/.test(html);
      const hasMcap  = /Market Cap/.test(html);
      const hasPE    = /Stock P\/E/.test(html);
      const hasQ     = /id="quarters"/.test(html);
      return { ok: hasPrice||hasMcap, detail:[hasPrice?'✓price':'✗price',hasMcap?'✓mcap':'✗mcap',hasPE?'✓PE':'✗PE',hasQ?'✓quarters':'✗quarters'].join(' | ') };
    }),

    chk('Yahoo Finance RELIANCE.NS', async () => {
      const result = await fetchYahoo('RELIANCE', '5d', '1d');
      const closes = result?.indicators?.quote?.[0]?.close?.filter(c=>c!=null);
      return { ok: closes?.length>0, detail: closes?.length+' closes', sample: 'Latest: '+closes?.[closes.length-1] };
    }),

    chk('Screener Latest Results page', async () => {
      const html = await fetchDirect('https://www.screener.in/screens/latest-results/', false, {'Referer':'https://www.screener.in/'});
      const syms = (html.match(/href="\/company\/[A-Z]/g)||[]).length;
      return { ok: syms > 5, detail: syms+' company links found' };
    }),

    chk('Moneycontrol Results Calendar', async () => {
      const html = await fetchDirect('https://www.moneycontrol.com/markets/earnings/results-calendar/', false, {'Referer':'https://www.moneycontrol.com/'});
      const nse = (html.match(/data-nse|NSE:/gi)||[]).length;
      return { ok: html.length > 1000, detail: 'Page size: '+html.length+' | NSE refs: '+nse };
    }),

  ]);

  const ok    = checks.filter(c=>c.status==='OK').length;
  const warn  = checks.filter(c=>c.status==='WARN').length;
  const error = checks.filter(c=>c.status==='ERROR').length;
  const overall = error > 4 ? 'DEGRADED' : error > 1 ? 'PARTIAL' : 'HEALTHY';

  // Scan-level status based on which sources are up
  const byName = Object.fromEntries(checks.map(c=>[c.name,c]));
  const scanStatus = {
    'Scan 1 (Earnings)': [byName['NSE Corporate Results (via proxy)'], byName['Screener Latest Results page'], byName['Screener.in (RELIANCE)']],
    'Scan 2 (RS)':       [byName['NSE Nifty500 CSV (via proxy)'],     byName['Yahoo Finance RELIANCE.NS']],
    'Scan 3 (Gainers)':  [byName['NSE Gainers allSec (via proxy)'],   byName['Yahoo Finance RELIANCE.NS']],
    'Scan 4 (IPO)':      [byName['NSE New Listings (via proxy)'],     byName['BSE IPO Data (direct)'], byName['Screener.in (RELIANCE)']],
  };
  const scanReport = {};
  for (const [scan, sources] of Object.entries(scanStatus)) {
    const allOk = sources.every(s=>s?.status==='OK');
    const anyOk = sources.some(s=>s?.status==='OK');
    scanReport[scan] = allOk ? '✅ All sources OK' : anyOk ? '⚠️ Partial — fallbacks active' : '❌ All sources down';
  }

  res.status(200).json({ overall, summary:{ok,warn,error,total:checks.length}, scan_status:scanReport, sources:checks, timestamp:new Date().toISOString() });
};
