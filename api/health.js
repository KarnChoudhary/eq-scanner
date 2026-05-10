// health.js v5 — honest tests, fixed Screener parsing verification
const { fetchDirect, fetchYahoo, fetchScreenerHTML, parseScreener } = require('./_utils');

async function chk(name, fn) {
  const start = Date.now();
  try {
    const result = await Promise.race([fn(), new Promise((_,r)=>setTimeout(()=>r(new Error('Timeout 8s')),8000))]);
    return { name, status: result.ok?'OK':'WARN', latency: Date.now()-start, detail: result.detail, sample: result.sample||null };
  } catch(e) {
    return { name, status:'ERROR', latency:Date.now()-start, detail:e.message, sample:null };
  }
}

module.exports = async function handler(req,res) {
  if (req.method==='OPTIONS') return res.status(200).end();

  const checks = await Promise.all([

    chk('Yahoo Finance (RELIANCE.NS)', async () => {
      const r = await fetchYahoo('RELIANCE','5d','1d');
      const c = r?.indicators?.quote?.[0]?.close?.filter(c=>c!=null);
      return {ok:c?.length>0, detail:c?.length+' closes. Latest: ₹'+c?.[c.length-1]?.toFixed(2)};
    }),

    chk('Yahoo Finance (TCS.NS)', async () => {
      const r = await fetchYahoo('TCS','5d','1d');
      const c = r?.indicators?.quote?.[0]?.close?.filter(c=>c!=null);
      return {ok:c?.length>0, detail:c?.length+' closes. Latest: ₹'+c?.[c.length-1]?.toFixed(2)};
    }),

    chk('Screener — RELIANCE parse', async () => {
      const html = await fetchScreenerHTML('RELIANCE');
      if (!html) throw new Error('No HTML returned');
      const s = parseScreener(html);
      return {
        ok: !!(s.price&&s.mcap),
        detail: [
          s.price ? '✓price ₹'+s.price : '✗price',
          s.mcap  ? '✓mcap '+s.mcap+'Cr' : '✗mcap',
          s.pe    ? '✓PE '+s.pe : '✗PE',
          s.quarters?.length ? '✓quarters('+s.quarters.length+'):'+s.quarters.map(q=>q.label).join(',') : '✗quarters'
        ].join(' | '),
        sample: 'Page: '+html.length+' chars'
      };
    }),

    chk('Screener — HDFCBANK quarters', async () => {
      const html = await fetchScreenerHTML('HDFCBANK');
      if (!html) throw new Error('No HTML');
      const s = parseScreener(html);
      const q = s.quarters||[];
      return {
        ok: q.length>=2,
        detail: q.length+' quarters. '+(q[0]?'Latest: '+q[0].label+' rev='+q[0].revenue+' pat='+q[0].pat:'none'),
        sample: q.map(x=>x.label+'(rev='+x.revenue+',pat='+x.pat+')').join(' | ')
      };
    }),

    chk('Screener — INFY MCap+PE', async () => {
      const html = await fetchScreenerHTML('INFY');
      if (!html) throw new Error('No HTML');
      const s = parseScreener(html);
      return {
        ok: !!(s.mcap&&s.pe),
        detail: 'mcap='+s.mcap+' pe='+s.pe+' price='+s.price+' sector='+s.sector
      };
    }),

    chk('Moneycontrol — Calendar HTML', async () => {
      const html = await fetchDirect('https://www.moneycontrol.com/markets/earnings/results-calendar/',false,{'Referer':'https://www.moneycontrol.com/'});
      const scripts = (html.match(/<script/g)||[]).length;
      const jsonBlobs = (html.match(/\{[^{}]{20,500}\}/g)||[]).length;
      // Count NSE symbol patterns
      const nseSyms = new Set();
      const re = /"NSEsymbol"\s*:\s*"([A-Z][A-Z0-9]{1,20})"/g; let m;
      while((m=re.exec(html))!==null) nseSyms.add(m[1]);
      return {ok:html.length>50000, detail:'Size:'+html.length+' scripts:'+scripts+' jsonBlobs:'+jsonBlobs+' NSEsyms:'+nseSyms.size, sample:nseSyms.size>0?[...nseSyms].slice(0,5).join(','):null};
    }),

    chk('Moneycontrol — find working API', async () => {
      const today=new Date().toISOString().slice(0,10);
      const past=new Date(Date.now()-30*86400000).toISOString().slice(0,10);
      const urls = [
        `https://api.moneycontrol.com/mcapi/v1/results/calendar?startDate=${past}&endDate=${today}&type=Q&exchange=NSE`,
        `https://www.moneycontrol.com/mccode/common/autosuggestion/getResultCalendarData.php?dateFrom=${past}&dateTo=${today}`,
        `https://priceapi.moneycontrol.com/pricefeed/nse/equitycash/results?period=quarterly`,
      ];
      const results = [];
      for (const url of urls) {
        try {
          const data = await Promise.race([
            fetchDirect(url,true,{'Referer':'https://www.moneycontrol.com/','Origin':'https://www.moneycontrol.com'}),
            new Promise((_,r)=>setTimeout(()=>r(new Error('timeout')),4000))
          ]);
          const rows = data?.data||data?.results||(Array.isArray(data)?data:[]);
          results.push(url.split('/').pop().split('?')[0]+':'+rows.length+'rows');
          if(rows.length>0) return {ok:true, detail:'Found: '+url.split('/').pop().split('?')[0]+' ('+rows.length+' rows)', sample:JSON.stringify(rows[0]).slice(0,100)};
        } catch(e) { results.push(url.split('/').pop().split('?')[0]+':'+e.message.slice(0,20)); }
      }
      return {ok:false, detail:'All MC APIs: '+results.join(' | ')};
    }),

    chk('Nifty500 hardcoded fallback', async () => {
      // This always works — just verify the module loads
      const { getNifty500 } = require('./nifty500');
      const list = await getNifty500([]);
      return {ok:list.length>100, detail:list.length+' stocks available. First: '+list[0]?.symbol};
    }),

  ]);

  const ok=checks.filter(c=>c.status==='OK').length;
  const warn=checks.filter(c=>c.status==='WARN').length;
  const error=checks.filter(c=>c.status==='ERROR').length;
  const overall=error>=4?'DEGRADED':error>=2?'PARTIAL':'HEALTHY';

  const byName=Object.fromEntries(checks.map(c=>[c.name,c]));
  const scanStatus={
    'Scan 1 (Earnings)': [byName['Screener — HDFCBANK quarters'],byName['Moneycontrol — Calendar HTML']],
    'Scan 2 (RS)':       [byName['Yahoo Finance (RELIANCE.NS)'],byName['Nifty500 hardcoded fallback']],
    'Scan 3 (Gainers)':  [byName['Yahoo Finance (RELIANCE.NS)'],byName['Yahoo Finance (TCS.NS)']],
    'Scan 4 (IPO)':      [byName['Yahoo Finance (RELIANCE.NS)'],byName['Screener — RELIANCE parse']],
  };
  const scanReport={};
  for(const [scan,sources] of Object.entries(scanStatus)){
    const allOk=sources.every(s=>s?.status==='OK');
    const anyOk=sources.some(s=>s?.status==='OK');
    scanReport[scan]=allOk?'✅ All sources OK':anyOk?'⚠️ Partial — some sources down':'❌ All sources down';
  }

  res.status(200).json({overall,summary:{ok,warn,error,total:checks.length},scan_status:scanReport,sources:checks,timestamp:new Date().toISOString()});
};
