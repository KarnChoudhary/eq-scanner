// isinmap.js v6
const { fetchDirect } = require('./_utils');
let cache = null, cacheAt = 0;
const TTL = 6 * 60 * 60 * 1000;
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (cache && Date.now() - cacheAt < TTL) return res.status(200).json({ map: cache });
  try {
    const url = 'https://corsproxy.io/?' + encodeURIComponent('https://archives.nseindia.com/content/equities/EQUITY_L.csv');
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text();
    if (text.trim()[0] === '<') throw new Error('Got HTML');
    const map = {};
    for (const line of text.split('\n').slice(1)) {
      const cols = line.split(',');
      const sym  = (cols[0] || '').replace(/"/g, '').trim();
      const isin = (cols[2] || '').replace(/"/g, '').trim();
      if (sym && isin && isin.startsWith('IN')) map[sym] = isin;
    }
    cache = map; cacheAt = Date.now();
    return res.status(200).json({ count: Object.keys(map).length, map });
  } catch (e) {
    return res.status(200).json({ count: 0, map: {}, error: e.message });
  }
};
