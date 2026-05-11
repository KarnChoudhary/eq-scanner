// health.js v6 — tests actual parse output with known correct values
const { fetchDirect, fetchYahoo, fetchScreenerHTML, parseScreener } = require('./_utils');

async function chk(name, fn) {
  const start = Date.now();
  try {
    const result = await Promise.race([fn(), new Promise((_, r) => setTimeout(() => r(new Error('Timeout 8s')), 8000))]);
    return { name, status: result.ok ? 'OK' : 'WARN', latency: Date.now() - start, detail: result.detail, sample: result.sample || null };
  } catch (e) {
    return { name, status: 'ERROR', latency: Date.now() - start, detail: e.message, sample: null };
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const checks = await Promise.all([

    chk('Yahoo Finance (RELIANCE.NS)', async () => {
      const r = await fetchYahoo('RELIANCE', '5d', '1d');
      const c = r?.indicators?.quote?.[0]?.close?.filter(c => c != null);
      return { ok: c?.length > 0, detail: c?.length + ' closes. Latest: ₹' + c?.[c.length - 1]?.toFixed(2) };
    }),

    chk('Yahoo Finance (TCS.NS)', async () => {
      const r = await fetchYahoo('TCS', '5d', '1d');
      const c = r?.indicators?.quote?.[0]?.close?.filter(c => c != null);
      return { ok: c?.length > 0, detail: c?.length + ' closes. Latest: ₹' + c?.[c.length - 1]?.toFixed(2) };
    }),

    chk('Screener — RELIANCE full parse', async () => {
      const html = await fetchScreenerHTML('RELIANCE');
      if (!html) throw new Error('No HTML returned');
      const s = parseScreener(html);
      // RELIANCE: price ~1435, mcap ~1942189, pe ~24, quarters >= 4
      const priceOk = s.price && s.price > 100 && s.price < 50000;
      const mcapOk  = s.mcap  && s.mcap  > 100000;
      const qOk     = s.quarters?.length >= 2;
      return {
        ok: priceOk && mcapOk && qOk,
        detail: [
          priceOk ? '✓price ₹' + s.price : '✗price=' + s.price,
          mcapOk  ? '✓mcap ' + s.mcap + 'Cr' : '✗mcap=' + s.mcap,
          s.pe    ? '✓PE ' + s.pe : '✗PE',
          qOk     ? '✓quarters(' + s.quarters.length + ')' : '✗quarters=' + (s.quarters?.length || 0),
          'sector=' + s.sector
        ].join(' | '),
        sample: s.quarters?.map(q => q.label + ':rev=' + q.revenue + ',pat=' + q.pat).join(' | ')
      };
    }),

    chk('Screener — HDFCBANK quarters', async () => {
      const html = await fetchScreenerHTML('HDFCBANK');
      if (!html) throw new Error('No HTML');
      const s = parseScreener(html);
      const q = s.quarters || [];
      return {
        ok: q.length >= 2 && q[0]?.revenue != null,
        detail: q.length + ' quarters found. Latest: ' + (q[0] ? q[0].label + ' rev=' + q[0].revenue + ' pat=' + q[0].pat : 'none'),
        sample: 'price='+s.price+' mcap='+s.mcap+' pe='+s.pe
      };
    }),

    chk('Screener — INFY MCap', async () => {
      const html = await fetchScreenerHTML('INFY');
      if (!html) throw new Error('No HTML');
      const s = parseScreener(html);
      // INFY mcap should be ~600000 Cr range
      return {
        ok: !!(s.mcap && s.mcap > 1000),
        detail: 'price=' + s.price + ' mcap=' + s.mcap + ' pe=' + s.pe + ' sector=' + s.sector
      };
    }),

    chk('Nifty500 hardcoded list', async () => {
      const { getNifty500 } = require('./nifty500');
      const list = await getNifty500([]);
      return { ok: list.length > 100, detail: list.length + ' stocks. First 3: ' + list.slice(0,3).map(s=>s.symbol).join(',') };
    }),

    chk('Moneycontrol — Calendar HTML', async () => {
      const html = await fetchDirect('https://www.moneycontrol.com/markets/earnings/results-calendar/', false, { 'Referer': 'https://www.moneycontrol.com/' });
      // Count NSE symbols using same patterns as earnings.js
      const seen = new Set();
      let m;
      const p1 = /"NSEsymbol"\s*:\s*"([^"]{1,25})"/gi;
      while ((m = p1.exec(html)) !== null) seen.add(m[1].toUpperCase());
      const p2 = /"nse_symbol"\s*:\s*"([^"]{1,25})"/gi;
      while ((m = p2.exec(html)) !== null) seen.add(m[1].toUpperCase());
      const p3 = /"sc_id"\s*:\s*"([A-Z][A-Z0-9]{1,20})"/gi;
      while ((m = p3.exec(html)) !== null) seen.add(m[1]);
      return {
        ok: html.length > 50000,
        detail: 'Size:' + html.length + ' NSEsyms found:' + seen.size,
        sample: seen.size > 0 ? [...seen].slice(0, 8).join(',') : 'none found — need different pattern'
      };
    }),

    chk('Moneycontrol — Results API discovery', async () => {
      // Try various MC API endpoints to find what works right now
      const today = new Date().toISOString().slice(0, 10);
      const past  = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const results = [];
      const urls = [
        `https://api.moneycontrol.com/mcapi/v1/results/calendar?startDate=${past}&endDate=${today}&type=Q&exchange=NSE`,
        `https://priceapi.moneycontrol.com/pricefeed/nse/equitycash/results?period=quarterly&dateFrom=${past}&dateTo=${today}`,
        `https://www.moneycontrol.com/mccode/common/autosuggestion/getResultCalendarData.php?dateFrom=${past}&dateTo=${today}`,
      ];
      for (const url of urls) {
        const key = url.split('/').slice(-1)[0].split('?')[0];
        try {
          const data = await Promise.race([
            fetchDirect(url, true, { 'Referer': 'https://www.moneycontrol.com/', 'Origin': 'https://www.moneycontrol.com' }),
            new Promise((_, r) => setTimeout(() => r(new Error('4s timeout')), 4000))
          ]);
          const rows = data?.data || data?.results || (Array.isArray(data) ? data : []);
          if (rows.length > 0) {
            return { ok: true, detail: key + ' works! ' + rows.length + ' rows', sample: JSON.stringify(rows[0]).slice(0, 120) };
          }
          results.push(key + ':0rows');
        } catch (e) { results.push(key + ':' + e.message.slice(0, 25)); }
      }
      return { ok: false, detail: 'All APIs: ' + results.join(' | ') };
    }),

  ]);

  const ok    = checks.filter(c => c.status === 'OK').length;
  const warn  = checks.filter(c => c.status === 'WARN').length;
  const error = checks.filter(c => c.status === 'ERROR').length;
  const overall = error >= 3 ? 'DEGRADED' : error >= 1 ? 'PARTIAL' : warn >= 3 ? 'PARTIAL' : 'HEALTHY';

  const byName = Object.fromEntries(checks.map(c => [c.name, c]));
  const scanStatus = {
    'Scan 1 (Earnings)': [byName['Screener — HDFCBANK quarters'], byName['Moneycontrol — Calendar HTML']],
    'Scan 2 (RS)':       [byName['Yahoo Finance (RELIANCE.NS)'],  byName['Nifty500 hardcoded list']],
    'Scan 3 (Gainers)':  [byName['Yahoo Finance (RELIANCE.NS)'],  byName['Yahoo Finance (TCS.NS)']],
    'Scan 4 (IPO)':      [byName['Yahoo Finance (RELIANCE.NS)'],  byName['Screener — RELIANCE full parse']],
  };
  const scanReport = {};
  for (const [scan, sources] of Object.entries(scanStatus)) {
    const allOk = sources.every(s => s?.status === 'OK');
    const anyOk = sources.some(s => s?.status === 'OK');
    scanReport[scan] = allOk ? '✅ All sources OK' : anyOk ? '⚠️ Partial — some sources down' : '❌ All sources down';
  }

  res.status(200).json({ overall, summary: { ok, warn, error, total: checks.length }, scan_status: scanReport, sources: checks, timestamp: new Date().toISOString() });
};
