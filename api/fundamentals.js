const { fetchScreenerHTML, parseScreener, fetchYahoo, sleep, sendError, sendOk } = require('./_utils');
const symCache = {}, TTL = 30*60*1000;
async function getFund(sym) {
  const c = symCache[sym]; if(c&&Date.now()-c.at<TTL) return c.data;
  let d={mcap:null,pe:null,price:null,sector:'N/A',avg_val:null};
  try { const h=await fetchScreenerHTML(sym); if(h){const p=parseScreener(h);d={mcap:p.mcap,pe:p.pe,price:p.price,sector:p.sector,avg_val:p.avg_val};} } catch{}
  if(!d.price){try{const ch=await fetchYahoo(sym,'5d','1d');const cl=ch?.indicators?.quote?.[0]?.close?.filter(c=>c!=null);if(cl?.length)d.price=Math.round(cl[cl.length-1]*100)/100;}catch{}}
  symCache[sym]={data:d,at:Date.now()}; return d;
}
module.exports=async function handler(req,res){
  if(req.method==='OPTIONS')return res.status(200).end();
  const syms=(req.query.symbols||'').split(',').map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,25);
  if(!syms.length)return sendError(res,400,'symbols required');
  try{
    const out={};const BATCH=4;
    for(let i=0;i<syms.length;i+=BATCH){
      const b=syms.slice(i,i+BATCH);
      const f=await Promise.allSettled(b.map(s=>getFund(s)));
      f.forEach((r,j)=>{out[b[j]]=r.status==='fulfilled'?r.value:{mcap:null,pe:null,price:null,sector:'N/A',avg_val:null};});
      if(i+BATCH<syms.length)await sleep(200);
    }
    return sendOk(res,{fundamentals:out});
  }catch(e){return sendError(res,500,'Fundamentals failed: '+e.message);}
};
