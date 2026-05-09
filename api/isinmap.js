// api/isinmap.js v3 — ISIN lookup for Upstox URLs via proxy
const { fetchViaProxy } = require('./_utils');
let cache=null, cacheAt=0;
const TTL=6*60*60*1000;
module.exports=async function handler(req,res){
  if(req.method==='OPTIONS')return res.status(200).end();
  res.setHeader('Access-Control-Allow-Origin','*');
  if(cache&&Date.now()-cacheAt<TTL)return res.status(200).json({map:cache});
  try{
    const text=await fetchViaProxy('https://archives.nseindia.com/content/equities/EQUITY_L.csv',false);
    const map={};
    for(const line of text.split('\n').slice(1)){
      const cols=line.split(',');
      const sym=(cols[0]||'').replace(/"/g,'').trim();
      const isin=(cols[2]||'').replace(/"/g,'').trim();
      if(sym&&isin&&isin.startsWith('IN'))map[sym]=isin;
    }
    cache=map; cacheAt=Date.now();
    return res.status(200).json({count:Object.keys(map).length,map});
  }catch(e){return res.status(500).json({error:true,message:e.message,map:{}});}
};
