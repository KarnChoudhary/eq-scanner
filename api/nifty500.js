// api/nifty500.js
// Returns Nifty 500 stock symbols from NSE public CSV
// Cached aggressively - list changes rarely (monthly rebalance)

const { sendError, sendOk } = require('./_utils');

let cachedList = null;
let cachedAt = 0;
const TTL = 6 * 60 * 60 * 1000; // 6 hours

async function getNifty500() {
  if (cachedList && Date.now() - cachedAt < TTL) return cachedList;

  // NSE publishes Nifty 500 constituents as a downloadable CSV
  const url = 'https://archives.nseindia.com/content/indices/ind_nifty500list.csv';
  
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.nseindia.com/',
      'Accept': 'text/csv,text/plain,*/*'
    }
  });

  if (!res.ok) throw new Error(`NSE Nifty500 CSV HTTP ${res.status}`);
  
  const text = await res.text();
  const lines = text.split('\n').slice(1); // skip header
  
  const symbols = [];
  for (const line of lines) {
    const cols = line.split(',');
    const symbol = cols[2]?.trim().replace(/"/g, ''); // Symbol is 3rd column
    const sector = cols[1]?.trim().replace(/"/g, '');
    const company = cols[0]?.trim().replace(/"/g, '');
    if (symbol && symbol.length > 0) {
      symbols.push({ symbol, company, sector });
    }
  }

  cachedList = symbols;
  cachedAt = Date.now();
  return symbols;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const list = await getNifty500();
    return sendOk(res, { count: list.length, stocks: list });
  } catch (e) {
    console.error('nifty500 error:', e.message);
    return sendError(res, 500, 'Failed to fetch Nifty 500 list: ' + e.message);
  }
};

// Export getter for use by other endpoints
module.exports.getNifty500 = getNifty500;
