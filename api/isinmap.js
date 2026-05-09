// api/isinmap.js
// NSE publishes equity symbol list with ISIN codes — used to build correct Upstox chart URLs
// Format: https://tv.upstox.com/trading-terminal/charts/NSE_EQ%7C{ISIN}
let cache=null, cacheAt=0;
const TTL=6*60*60*1000;
module.exports=async function handler(req,res){
  if(req.method==='OPTIONS')return res.status(200).end();
  res.setHeader('Access-Control-Allow-Origin','*');
  if(cache&&Date.now()-cacheAt<TTL)return res.status(200).json({map:cache});
  try{
    const r=await fetch('https://archives.nseindia.com/content/equities/EQUITY_L.csv',{
      headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Referer':'https://www.nseindia.com/','Accept':'text/csv'}
    });
    if(!r.ok)throw new Error('HTTP '+r.status);
    const text=await r.text();
    const lines=text.split('\n').slice(1);
    const map={};
    for(const line of lines){
      const cols=line.split(',');
      const sym=(cols[0]||'').replace(/"/g,'').trim();
      const isin=(cols[2]||'').replace(/"/g,'').trim();
      if(sym&&isin&&isin.startsWith('IN'))map[sym]=isin;
    }
    cache=map; cacheAt=Date.now();
    return res.status(200).json({count:Object.keys(map).length,map});
  }catch(e){
    return res.status(500).json({error:true,message:e.message,map:{}});
  }
};
