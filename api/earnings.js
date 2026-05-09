// api/earnings.js v2 — multi-source, self-diagnosing
const { sendError, sendOk, sleep } = require('./_utils');
let cache = null, cacheAt = 0;
const TTL = 20 * 60 * 1000;

function within30d(ds) {
  if (!ds) return false;
  try { const d=new Date(ds); const diff=Date.now()-d.getTime(); return diff>=0&&diff<=30*864e5; } catch{return false;}
}
function qoq(c,p){ if(c==null||p==null||p===0)return null; return Math.round(((c-p)/Math.abs(p))*1000)/10; }

let _ck='',_ckat=0;
async function nCk(){
  if(_ck&&Date.now()-_ckat<8*6e4)return _ck;
  try{
    const r=await fetch('https://www.nseindia.com',{headers:{'User-Agent':'Mozilla/5.0','Accept':'text/html'}});
    const sc=r.headers.get('set-cookie')||'';
    _ck=sc.split(',').map(c=>c.split(';')[0].trim()).filter(c=>c.includes('=')).join('; ');
    _ckat=Date.now();
  }catch{}
  return _ck;
}

async function srcNSE(log){
  try{
    const ck=await nCk();
    const r=await fetch('https://www.nseindia.com/api/corporate-announcements?index=equities&subject=Financial+Results',{
      headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept':'application/json','Referer':'https://www.nseindia.com/','Cookie':ck}
    });
    if(!r.ok)throw new Error('HTTP '+r.status);
    const data=await r.json();
    const rows=Array.isArray(data)?data:(data.data||[]);
    log.push('NSE announcements: '+rows.length+' rows');
    const syms=[];
    for(const r2 of rows){
      const dt=r2.bcastDt||r2.an_dt||r2.date||'';
      const sym=(r2.symbol||r2.Symbol||'').trim().toUpperCase();
      if(sym&&within30d(dt)) syms.push({symbol:sym,result_date:dt});
    }
    log.push('NSE within 30d: '+syms.length);
    return syms;
  }catch(e){log.push('NSE failed: '+e.message);return[];}
}

async function srcScreenerList(log){
  try{
    const r=await fetch('https://www.screener.in/screens/latest-results/',{
      headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept':'text/html','Referer':'https://www.screener.in/'}
    });
    if(!r.ok)throw new Error('HTTP '+r.status);
    const html=await r.text();
    const re=/href="\/company\/([A-Z0-9]+)\/"[^>]*>.*?(\d{1,2}[\s\-]\w+[\s\-]\d{4})/gi;
    const syms=[]; let m;
    while((m=re.exec(html))!==null){
      if(within30d(m[2])) syms.push({symbol:m[1],result_date:m[2]});
    }
    log.push('Screener list: '+syms.length+' within 30d');
    return syms;
  }catch(e){log.push('Screener list failed: '+e.message);return[];}
}

async function srcMoneycontrol(log){
  try{
    // Moneycontrol results calendar - public
    const today=new Date();
    const dd=String(today.getDate()).padStart(2,'0');
    const mm=String(today.getMonth()+1).padStart(2,'0');
    const yyyy=today.getFullYear();
    // 30 days back
    const past=new Date(Date.now()-30*864e5);
    const pdd=String(past.getDate()).padStart(2,'0');
    const pmm=String(past.getMonth()+1).padStart(2,'0');
    const pyyyy=past.getFullYear();
    const url=`https://www.moneycontrol.com/markets/earnings/results-calendar/?dateRangeFrom=${pyyyy}-${pmm}-${pdd}&dateRangeTo=${yyyy}-${mm}-${dd}`;
    const r=await fetch(url,{
      headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept':'text/html','Referer':'https://www.moneycontrol.com/'}
    });
    if(!r.ok)throw new Error('HTTP '+r.status);
    const html=await r.text();
    // Parse NSE symbols from data attributes or links
    const re=/data-nse_code="([A-Z0-9]+)"[^>]*data-result_date="([^"]+)"/gi;
    const re2=/nse_code=([A-Z0-9]+)[^&]*.*?(\d{4}-\d{2}-\d{2})/gi;
    const syms=[]; let m;
    while((m=re.exec(html))!==null){
      if(within30d(m[2])) syms.push({symbol:m[1],result_date:m[2]});
    }
    while((m=re2.exec(html))!==null){
      if(within30d(m[2])&&!syms.find(s=>s.symbol===m[1])) syms.push({symbol:m[1],result_date:m[2]});
    }
    log.push('Moneycontrol: '+syms.length+' within 30d');
    return syms;
  }catch(e){log.push('Moneycontrol failed: '+e.message);return[];}
}

async function getScreener(symbol){
  const urls=[
    `https://www.screener.in/company/${symbol}/consolidated/`,
    `https://www.screener.in/company/${symbol}/`
  ];
  for(const url of urls){
    try{
      const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept':'text/html','Referer':'https://www.screener.in/'}});
      if(!r.ok)continue;
      const html=await r.text();
      return parseScreener(html,symbol);
    }catch{continue;}
  }
  return null;
}

function parseScreener(html,symbol){
  const out={symbol,mcap:null,pe:null,price:null,sector:'N/A',avg_val:null,quarters:[]};
  try{
    const prM=html.match(/id="current-price"[^>]*>\s*([\d,]+(?:\.\d+)?)/i)||html.match(/"current_price"\s*:\s*([\d.]+)/i);
    if(prM)out.price=parseFloat(prM[1].replace(/,/g,''));
    const mcM=html.match(/Market Cap[^<]*<\/[^>]+>\s*<[^>]+>\s*₹?\s*([\d,]+(?:\.\d+)?)/i);
    if(mcM)out.mcap=parseFloat(mcM[1].replace(/,/g,''));
    const peM=html.match(/Stock P\/E[^<]*<\/[^>]+>\s*<[^>]+>\s*([\d.]+)/i);
    if(peM)out.pe=parseFloat(peM[1]);
    const jldM=html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i);
    if(jldM){try{const jd=JSON.parse(jldM[1]);out.sector=jd.industry||jd.sector||'N/A';}catch{}}
    // quarters section
    const qSecM=html.match(/id="quarters"[\s\S]*?<\/section>/i);
    if(qSecM){
      const tbl=qSecM[0];
      const hRe=/<th[^>]*>((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*['']?\d{2,4})<\/th>/gi;
      const hdrs=[]; let hm;
      while((hm=hRe.exec(tbl))!==null)hdrs.push(hm[1]);
      const salesRow=tbl.match(/>\s*Sales\s*[\s\S]*?<\/tr>/i);
      const patRow=tbl.match(/>\s*Net Profit\s*[\s\S]*?<\/tr>/i);
      const sVals=salesRow?extractNums(salesRow[0]):[];
      const pVals=patRow?extractNums(patRow[0]):[];
      for(let i=0;i<Math.min(hdrs.length,4);i++){
        out.quarters.push({label:hdrs[i],revenue:sVals[i]??null,pat:pVals[i]??null});
      }
    }
    const volM=html.match(/10\s*Day\s*Avg[^<]*<\/[^>]+>\s*<[^>]+>\s*([\d,]+)/i);
    if(volM&&out.price){const v=parseFloat(volM[1].replace(/,/g,''));out.avg_val=Math.round(v*out.price/1e7*10)/10;}
  }catch{}
  return out;
}

function extractNums(rowHtml){
  const vals=[]; const re=/<td[^>]*>\s*([\d,\-]+(?:\.\d+)?)\s*<\/td>/g; let m;
  while((m=re.exec(rowHtml))!==null){const v=parseFloat(m[1].replace(/,/g,''));if(!isNaN(v))vals.push(v);}
  return vals;
}

module.exports=async function handler(req,res){
  if(req.method==='OPTIONS')return res.status(200).end();
  const revThresh=parseFloat(req.query.rev_thresh)||20;
  const patThresh=parseFloat(req.query.pat_thresh)||20;
  const mcapMin=parseFloat(req.query.mcap_min)||1000;
  const mcapMax=parseFloat(req.query.mcap_max)||50000;
  const priceMin=parseFloat(req.query.price_min)||20;
  const peMax=parseFloat(req.query.pe_max)||35;
  const valMin=parseFloat(req.query.val_min)||5;
  if(cache&&Date.now()-cacheAt<TTL){
    const f=applyF(cache,{revThresh,patThresh,mcapMin,mcapMax,priceMin,peMax,valMin});
    return sendOk(res,{count:f.length,stocks:f,cached:true});
  }
  const log=[];
  try{
    const [r1,r2,r3]=await Promise.all([srcNSE(log),srcScreenerList(log),srcMoneycontrol(log)]);
    const symMap=new Map();
    for(const s of [...r1,...r2,...r3]){if(!symMap.has(s.symbol))symMap.set(s.symbol,s);}
    log.push('Total unique symbols: '+symMap.size);
    if(!symMap.size){
      return sendOk(res,{count:0,stocks:[],note:'No results in last 30 days from any source.',diag:log});
    }
    const BATCH=5; const syms=[...symMap.values()]; const enriched=[];
    for(let i=0;i<Math.min(syms.length,80);i+=BATCH){
      const batch=syms.slice(i,i+BATCH);
      const results=await Promise.allSettled(batch.map(s=>getScreener(s.symbol)));
      for(let j=0;j<batch.length;j++){
        const raw=batch[j]; const r=results[j];
        if(r.status!=='fulfilled'||!r.value){log.push(raw.symbol+': screener failed');continue;}
        const s=r.value;
        if(!s.quarters||s.quarters.length<2){log.push(raw.symbol+': quarters<2');continue;}
        const rQoQ=qoq(s.quarters[0].revenue,s.quarters[1].revenue);
        const pQoQ=qoq(s.quarters[0].pat,s.quarters[1].pat);
        if(rQoQ===null||pQoQ===null){log.push(raw.symbol+': null qoq');continue;}
        enriched.push({symbol:raw.symbol,name:raw.symbol,sector:s.sector||'N/A',result_date:raw.result_date,
          revenue:s.quarters[0].revenue,rev_qoq:rQoQ,pat:s.quarters[0].pat,pat_qoq:pQoQ,
          mcap:s.mcap,pe:s.pe,price:s.price,avg_val:s.avg_val});
        log.push(raw.symbol+' OK rev='+rQoQ+'% pat='+pQoQ+'%');
      }
      if(i+BATCH<syms.length)await sleep(250);
    }
    cache=enriched; cacheAt=Date.now();
    const filtered=applyF(enriched,{revThresh,patThresh,mcapMin,mcapMax,priceMin,peMax,valMin});
    return sendOk(res,{count:filtered.length,stocks:filtered,diag:log});
  }catch(e){
    return sendError(res,500,'Earnings failed: '+e.message);
  }
};

function applyF(stocks,f){
  return stocks.filter(s=>{
    if(s.rev_qoq<f.revThresh)return false;
    if(s.pat_qoq<f.patThresh)return false;
    if(s.mcap!=null&&s.mcap<f.mcapMin)return false;
    if(s.mcap!=null&&s.mcap>f.mcapMax)return false;
    if(s.price!=null&&s.price<f.priceMin)return false;
    if(s.pe!=null&&s.pe>f.peMax)return false;
    if(s.avg_val!=null&&s.avg_val<f.valMin)return false;
    return true;
  }).sort((a,b)=>b.pat_qoq-a.pat_qoq);
}
