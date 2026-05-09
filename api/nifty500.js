// api/nifty500.js v3
// NSE blocks direct requests from Vercel. Use multiple fallback sources.
// Primary: NSE CSV via allorigins proxy
// Fallback 1: Hardcoded Nifty 500 symbols (last updated May 2025)
// Fallback 2: Wikipedia Nifty 500 list

const { fetchViaProxy, fetchDirect, sendError, sendOk } = require('./_utils');

let cache = null, cacheAt = 0;
const TTL = 6 * 60 * 60 * 1000;

// Minimal hardcoded top-200 Nifty 500 stocks as emergency fallback
// Sector data included. Updated May 2025.
const HARDCODED = [
  {symbol:'RELIANCE',company:'Reliance Industries',sector:'Energy'},
  {symbol:'TCS',company:'Tata Consultancy Services',sector:'IT'},
  {symbol:'HDFCBANK',company:'HDFC Bank',sector:'Banking'},
  {symbol:'BHARTIARTL',company:'Bharti Airtel',sector:'Telecom'},
  {symbol:'ICICIBANK',company:'ICICI Bank',sector:'Banking'},
  {symbol:'INFOSYS',company:'Infosys',sector:'IT'},
  {symbol:'SBIN',company:'State Bank of India',sector:'Banking'},
  {symbol:'HINDUNILVR',company:'Hindustan Unilever',sector:'FMCG'},
  {symbol:'ITC',company:'ITC',sector:'FMCG'},
  {symbol:'LT',company:'Larsen & Toubro',sector:'Capital Goods'},
  {symbol:'KOTAKBANK',company:'Kotak Mahindra Bank',sector:'Banking'},
  {symbol:'AXISBANK',company:'Axis Bank',sector:'Banking'},
  {symbol:'WIPRO',company:'Wipro',sector:'IT'},
  {symbol:'HCLTECH',company:'HCL Technologies',sector:'IT'},
  {symbol:'ASIANPAINT',company:'Asian Paints',sector:'Paints'},
  {symbol:'MARUTI',company:'Maruti Suzuki',sector:'Auto'},
  {symbol:'SUNPHARMA',company:'Sun Pharma',sector:'Pharma'},
  {symbol:'TATAMOTORS',company:'Tata Motors',sector:'Auto'},
  {symbol:'ULTRACEMCO',company:'UltraTech Cement',sector:'Cement'},
  {symbol:'ADANIPORTS',company:'Adani Ports',sector:'Infrastructure'},
  {symbol:'TITAN',company:'Titan Company',sector:'Consumer'},
  {symbol:'BAJFINANCE',company:'Bajaj Finance',sector:'NBFC'},
  {symbol:'NTPC',company:'NTPC',sector:'Power'},
  {symbol:'POWERGRID',company:'Power Grid',sector:'Power'},
  {symbol:'NESTLEIND',company:'Nestle India',sector:'FMCG'},
  {symbol:'TECHM',company:'Tech Mahindra',sector:'IT'},
  {symbol:'BAJAJFINSV',company:'Bajaj Finserv',sector:'Finance'},
  {symbol:'ONGC',company:'ONGC',sector:'Oil & Gas'},
  {symbol:'JSWSTEEL',company:'JSW Steel',sector:'Metals'},
  {symbol:'TATASTEEL',company:'Tata Steel',sector:'Metals'},
  {symbol:'M&M',company:'Mahindra & Mahindra',sector:'Auto'},
  {symbol:'DRREDDY',company:'Dr Reddy\'s',sector:'Pharma'},
  {symbol:'CIPLA',company:'Cipla',sector:'Pharma'},
  {symbol:'EICHERMOT',company:'Eicher Motors',sector:'Auto'},
  {symbol:'COALINDIA',company:'Coal India',sector:'Mining'},
  {symbol:'DIVISLAB',company:'Divi\'s Lab',sector:'Pharma'},
  {symbol:'GRASIM',company:'Grasim Industries',sector:'Diversified'},
  {symbol:'BPCL',company:'BPCL',sector:'Oil & Gas'},
  {symbol:'HINDALCO',company:'Hindalco',sector:'Metals'},
  {symbol:'VEDL',company:'Vedanta',sector:'Metals'},
  {symbol:'APOLLOHOSP',company:'Apollo Hospitals',sector:'Healthcare'},
  {symbol:'TATACONSUM',company:'Tata Consumer',sector:'FMCG'},
  {symbol:'ADANIENT',company:'Adani Enterprises',sector:'Diversified'},
  {symbol:'HEROMOTOCO',company:'Hero MotoCorp',sector:'Auto'},
  {symbol:'BAJAJ-AUTO',company:'Bajaj Auto',sector:'Auto'},
  {symbol:'BRITANNIA',company:'Britannia',sector:'FMCG'},
  {symbol:'SHRIRAMFIN',company:'Shriram Finance',sector:'NBFC'},
  {symbol:'INDUSINDBK',company:'IndusInd Bank',sector:'Banking'},
  {symbol:'TRENT',company:'Trent',sector:'Retail'},
  {symbol:'ZOMATO',company:'Zomato',sector:'Consumer Tech'},
  {symbol:'PAYTM',company:'Paytm',sector:'Fintech'},
  {symbol:'NYKAA',company:'Nykaa',sector:'Retail'},
  {symbol:'DMART',company:'Avenue Supermarts',sector:'Retail'},
  {symbol:'PIDILITIND',company:'Pidilite Industries',sector:'Chemicals'},
  {symbol:'SIEMENS',company:'Siemens',sector:'Capital Goods'},
  {symbol:'ABB',company:'ABB India',sector:'Capital Goods'},
  {symbol:'HAVELLS',company:'Havells India',sector:'Electricals'},
  {symbol:'VOLTAS',company:'Voltas',sector:'Consumer Durables'},
  {symbol:'GODREJCP',company:'Godrej Consumer',sector:'FMCG'},
  {symbol:'DABUR',company:'Dabur India',sector:'FMCG'},
  {symbol:'MARICO',company:'Marico',sector:'FMCG'},
  {symbol:'COLPAL',company:'Colgate-Palmolive',sector:'FMCG'},
  {symbol:'EMAMILTD',company:'Emami',sector:'FMCG'},
  {symbol:'MUTHOOTFIN',company:'Muthoot Finance',sector:'NBFC'},
  {symbol:'CHOLAFIN',company:'Cholamandalam Finance',sector:'NBFC'},
  {symbol:'PFC',company:'Power Finance Corp',sector:'Finance'},
  {symbol:'RECLTD',company:'REC',sector:'Finance'},
  {symbol:'IRFC',company:'Indian Railway Finance',sector:'Finance'},
  {symbol:'HAL',company:'HAL',sector:'Defence'},
  {symbol:'BEL',company:'Bharat Electronics',sector:'Defence'},
  {symbol:'BHEL',company:'BHEL',sector:'Capital Goods'},
  {symbol:'SAIL',company:'SAIL',sector:'Metals'},
  {symbol:'NMDC',company:'NMDC',sector:'Mining'},
  {symbol:'NHPC',company:'NHPC',sector:'Power'},
  {symbol:'SJVN',company:'SJVN',sector:'Power'},
  {symbol:'IREDA',company:'IREDA',sector:'Finance'},
  {symbol:'CANBK',company:'Canara Bank',sector:'Banking'},
  {symbol:'BANKBARODA',company:'Bank of Baroda',sector:'Banking'},
  {symbol:'PNB',company:'Punjab National Bank',sector:'Banking'},
  {symbol:'UNIONBANK',company:'Union Bank',sector:'Banking'},
  {symbol:'INDIANB',company:'Indian Bank',sector:'Banking'},
  {symbol:'IDFCFIRSTB',company:'IDFC First Bank',sector:'Banking'},
  {symbol:'FEDERALBNK',company:'Federal Bank',sector:'Banking'},
  {symbol:'BANDHANBNK',company:'Bandhan Bank',sector:'Banking'},
  {symbol:'RBLBANK',company:'RBL Bank',sector:'Banking'},
  {symbol:'YESBANK',company:'Yes Bank',sector:'Banking'},
  {symbol:'AUBANK',company:'AU Small Finance Bank',sector:'Banking'},
  {symbol:'HDFCLIFE',company:'HDFC Life Insurance',sector:'Insurance'},
  {symbol:'SBILIFE',company:'SBI Life Insurance',sector:'Insurance'},
  {symbol:'LICI',company:'LIC India',sector:'Insurance'},
  {symbol:'ICICIPRULI',company:'ICICI Prudential Life',sector:'Insurance'},
  {symbol:'STARHEALTH',company:'Star Health Insurance',sector:'Insurance'},
  {symbol:'GICRE',company:'GIC Re',sector:'Insurance'},
  {symbol:'NIACL',company:'New India Assurance',sector:'Insurance'},
  {symbol:'HDFCAMC',company:'HDFC AMC',sector:'Finance'},
  {symbol:'NIPPONLIFE',company:'Nippon Life AMC',sector:'Finance'},
  {symbol:'ICICIGI',company:'ICICI Lombard',sector:'Insurance'},
  {symbol:'SBICARD',company:'SBI Card',sector:'Finance'},
  {symbol:'MEDIASSIST',company:'Medi Assist',sector:'Healthcare'},
  {symbol:'MAXHEALTH',company:'Max Healthcare',sector:'Healthcare'},
  {symbol:'FORTIS',company:'Fortis Healthcare',sector:'Healthcare'},
  {symbol:'NARAYANA',company:'Narayana Hrudayalaya',sector:'Healthcare'},
  {symbol:'KIMS',company:'Krishna Institute of Medical',sector:'Healthcare'},
  {symbol:'PGHL',company:'Procter & Gamble',sector:'FMCG'},
  {symbol:'GILLETTE',company:'Gillette India',sector:'FMCG'},
  {symbol:'UNILEVER',company:'HUL',sector:'FMCG'},
  {symbol:'MCDOWELL-N',company:'United Spirits',sector:'Beverages'},
  {symbol:'RADICO',company:'Radico Khaitan',sector:'Beverages'},
  {symbol:'UNITDSPR',company:'United Breweries',sector:'Beverages'},
  {symbol:'JUBLFOOD',company:'Jubilant Foodworks',sector:'QSR'},
  {symbol:'DEVYANI',company:'Devyani International',sector:'QSR'},
  {symbol:'WESTLIFE',company:'Westlife Foodworld',sector:'QSR'},
  {symbol:'SAPPHIRE',company:'Sapphire Foods',sector:'QSR'},
  {symbol:'NAUKRI',company:'Info Edge',sector:'Internet'},
  {symbol:'POLICYBZR',company:'PB Fintech',sector:'Fintech'},
  {symbol:'CARTRADE',company:'CarTrade Tech',sector:'Internet'},
  {symbol:'INDIAMART',company:'IndiaMART',sector:'Internet'},
  {symbol:'JUSTDIAL',company:'Just Dial',sector:'Internet'},
  {symbol:'DIXON',company:'Dixon Technologies',sector:'Electronics'},
  {symbol:'AMBER',company:'Amber Enterprises',sector:'Electronics'},
  {symbol:'KAYNES',company:'Kaynes Technology',sector:'Electronics'},
  {symbol:'SYRMA',company:'Syrma SGS Technology',sector:'Electronics'},
  {symbol:'APARINDS',company:'Apar Industries',sector:'Cables'},
  {symbol:'POLYCAB',company:'Polycab India',sector:'Electricals'},
  {symbol:'KEI',company:'KEI Industries',sector:'Cables'},
  {symbol:'FINOLEX',company:'Finolex Cables',sector:'Cables'},
  {symbol:'ASTRAL',company:'Astral',sector:'Pipes'},
  {symbol:'SUPREMEIND',company:'Supreme Industries',sector:'Plastics'},
  {symbol:'PRINCEPIPE',company:'Prince Pipes',sector:'Pipes'},
  {symbol:'CERA',company:'Cera Sanitaryware',sector:'Building Materials'},
  {symbol:'KAJARIACER',company:'Kajaria Ceramics',sector:'Building Materials'},
  {symbol:'ORIENTBELL',company:'Orient Bell',sector:'Building Materials'},
  {symbol:'CENTURYPLY',company:'Century Plyboards',sector:'Building Materials'},
  {symbol:'GREENPANEL',company:'Greenpanel Industries',sector:'Building Materials'},
  {symbol:'PIDILITIND',company:'Pidilite Industries',sector:'Chemicals'},
  {symbol:'SRF',company:'SRF',sector:'Chemicals'},
  {symbol:'DEEPAKNITR',company:'Deepak Nitrite',sector:'Chemicals'},
  {symbol:'NAVINFLUOR',company:'Navin Fluorine',sector:'Chemicals'},
  {symbol:'CLEAN',company:'Clean Science',sector:'Chemicals'},
  {symbol:'AAVAS',company:'Aavas Financiers',sector:'Housing Finance'},
  {symbol:'HOMEFIRST',company:'Home First Finance',sector:'Housing Finance'},
  {symbol:'PNBHOUSING',company:'PNB Housing Finance',sector:'Housing Finance'},
  {symbol:'LICHSGFIN',company:'LIC Housing Finance',sector:'Housing Finance'},
  {symbol:'CANFINHOME',company:'Can Fin Homes',sector:'Housing Finance'},
  {symbol:'BAJAJHFL',company:'Bajaj Housing Finance',sector:'Housing Finance'},
  {symbol:'GODREJPROP',company:'Godrej Properties',sector:'Real Estate'},
  {symbol:'DLF',company:'DLF',sector:'Real Estate'},
  {symbol:'OBEROIRLTY',company:'Oberoi Realty',sector:'Real Estate'},
  {symbol:'PRESTIGE',company:'Prestige Estates',sector:'Real Estate'},
  {symbol:'BRIGADE',company:'Brigade Enterprises',sector:'Real Estate'},
  {symbol:'SOBHA',company:'Sobha',sector:'Real Estate'},
  {symbol:'PHOENIXLTD',company:'Phoenix Mills',sector:'Real Estate'},
  {symbol:'NUVOCO',company:'Nuvoco Vistas',sector:'Cement'},
  {symbol:'DALBHARAT',company:'Dalmia Bharat',sector:'Cement'},
  {symbol:'RAMCOCEM',company:'Ramco Cements',sector:'Cement'},
  {symbol:'JKCEMENT',company:'JK Cement',sector:'Cement'},
  {symbol:'SHREECEM',company:'Shree Cement',sector:'Cement'},
  {symbol:'ACC',company:'ACC',sector:'Cement'},
  {symbol:'AMBUJACEM',company:'Ambuja Cements',sector:'Cement'},
  {symbol:'TATAPOWER',company:'Tata Power',sector:'Power'},
  {symbol:'TORNTPOWER',company:'Torrent Power',sector:'Power'},
  {symbol:'CESC',company:'CESC',sector:'Power'},
  {symbol:'ADANIGREEN',company:'Adani Green Energy',sector:'Renewable Energy'},
  {symbol:'ADANITRANS',company:'Adani Transmission',sector:'Power'},
  {symbol:'RPOWER',company:'Reliance Power',sector:'Power'},
  {symbol:'IOC',company:'Indian Oil Corporation',sector:'Oil & Gas'},
  {symbol:'HINDPETRO',company:'HPCL',sector:'Oil & Gas'},
  {symbol:'PETRONET',company:'Petronet LNG',sector:'Oil & Gas'},
  {symbol:'GAIL',company:'GAIL India',sector:'Gas'},
  {symbol:'IGL',company:'Indraprastha Gas',sector:'Gas'},
  {symbol:'MGL',company:'Mahanagar Gas',sector:'Gas'},
  {symbol:'GUJGASLTD',company:'Gujarat Gas',sector:'Gas'},
  {symbol:'ATGL',company:'Adani Total Gas',sector:'Gas'},
  {symbol:'ZYDUSLIFE',company:'Zydus Lifesciences',sector:'Pharma'},
  {symbol:'TORNTPHARM',company:'Torrent Pharma',sector:'Pharma'},
  {symbol:'LUPIN',company:'Lupin',sector:'Pharma'},
  {symbol:'AUROPHARMA',company:'Aurobindo Pharma',sector:'Pharma'},
  {symbol:'ALKEM',company:'Alkem Laboratories',sector:'Pharma'},
  {symbol:'IPCA',company:'IPCA Laboratories',sector:'Pharma'},
  {symbol:'GLENMARK',company:'Glenmark Pharma',sector:'Pharma'},
  {symbol:'IPCALAB',company:'IPCA Lab',sector:'Pharma'},
  {symbol:'ABBOTINDIA',company:'Abbott India',sector:'Pharma'},
  {symbol:'PFIZER',company:'Pfizer',sector:'Pharma'},
  {symbol:'SANOFI',company:'Sanofi India',sector:'Pharma'},
  {symbol:'MFSL',company:'Max Financial Services',sector:'Finance'},
  {symbol:'MOTILALOFS',company:'Motilal Oswal',sector:'Finance'},
  {symbol:'360ONE',company:'360 One WAM',sector:'Finance'},
  {symbol:'ANGELONE',company:'Angel One',sector:'Finance'},
  {symbol:'ICICISEC',company:'ICICI Securities',sector:'Finance'},
  {symbol:'NUVAMA',company:'Nuvama Wealth',sector:'Finance'},
  {symbol:'CAMS',company:'CAMS',sector:'Finance'},
  {symbol:'BSE',company:'BSE',sector:'Finance'},
  {symbol:'MCX',company:'Multi Commodity Exchange',sector:'Finance'},
  {symbol:'CDSL',company:'CDSL',sector:'Finance'},
  {symbol:'IRCTC',company:'IRCTC',sector:'Travel'},
  {symbol:'RAILTEL',company:'RailTel Corporation',sector:'Telecom'},
  {symbol:'RVNL',company:'Rail Vikas Nigam',sector:'Infrastructure'},
  {symbol:'NBCC',company:'NBCC',sector:'Infrastructure'},
  {symbol:'ENGINERSIN',company:'Engineers India',sector:'Infrastructure'},
  {symbol:'TIINDIA',company:'Tube Investments',sector:'Auto Ancillary'},
  {symbol:'MOTHERSON',company:'Samvardhana Motherson',sector:'Auto Ancillary'},
  {symbol:'BOSCHLTD',company:'Bosch',sector:'Auto Ancillary'},
  {symbol:'BHARATFORG',company:'Bharat Forge',sector:'Auto Ancillary'},
  {symbol:'SUNDRMFAST',company:'Sundram Fasteners',sector:'Auto Ancillary'},
  {symbol:'SCHAEFFLER',company:'Schaeffler India',sector:'Auto Ancillary'},
  {symbol:'SKFINDIA',company:'SKF India',sector:'Auto Ancillary'},
  {symbol:'TIMKEN',company:'Timken India',sector:'Auto Ancillary'},
  {symbol:'EXIDEIND',company:'Exide Industries',sector:'Auto Ancillary'},
  {symbol:'AMARARAJA',company:'Amara Raja Energy',sector:'Auto Ancillary'},
  {symbol:'MRF',company:'MRF',sector:'Tyres'},
  {symbol:'APOLLOTYRE',company:'Apollo Tyres',sector:'Tyres'},
  {symbol:'BALKRISIND',company:'Balkrishna Industries',sector:'Tyres'},
  {symbol:'CEATLTD',company:'CEAT',sector:'Tyres'},
];

async function fetchNifty500Live(log) {
  // Try NSE CSV via proxy
  const csvUrl = 'https://archives.nseindia.com/content/indices/ind_nifty500list.csv';
  try {
    const text = await fetchViaProxy(csvUrl, false);
    const lines = text.split('\n').filter(l => l.trim());
    log.push('NSE CSV via proxy: ' + lines.length + ' lines');
    if (lines.length > 100) {
      // Parse CSV: Company Name, Industry, Symbol, Series, ISIN
      const stocks = [];
      for (const line of lines.slice(1)) {
        const cols = line.split(',').map(c => c.replace(/"/g,'').trim());
        if (cols.length >= 3 && cols[2]) {
          stocks.push({ symbol: cols[2], company: cols[0], sector: cols[1] || 'N/A' });
        }
      }
      if (stocks.length > 100) { log.push('Parsed: ' + stocks.length + ' stocks'); return stocks; }
    }
  } catch (e) { log.push('NSE CSV proxy failed: ' + e.message); }

  // Try NSE JSON indices endpoint via proxy
  try {
    const url = 'https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20500';
    const data = await fetchViaProxy(url, true);
    const arr = data?.data || [];
    log.push('NSE Nifty500 JSON via proxy: ' + arr.length + ' stocks');
    if (arr.length > 100) {
      return arr.map(s => ({
        symbol: (s.symbol || s.Symbol || '').trim().toUpperCase(),
        company: s.companyName || s.symbol || '',
        sector: s.industry || s.sector || 'N/A'
      })).filter(s => s.symbol);
    }
  } catch (e) { log.push('NSE JSON proxy failed: ' + e.message); }

  // Final fallback: hardcoded list
  log.push('Using hardcoded Nifty500 list (' + HARDCODED.length + ' stocks)');
  return HARDCODED;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (cache && Date.now() - cacheAt < TTL) return sendOk(res, { count: cache.length, stocks: cache, cached: true });
  const log = [];
  try {
    const stocks = await fetchNifty500Live(log);
    cache = stocks; cacheAt = Date.now();
    return sendOk(res, { count: stocks.length, stocks, log });
  } catch (e) {
    return sendError(res, 500, 'Nifty500 failed: ' + e.message);
  }
};

module.exports.getNifty500 = async function(log = []) {
  if (cache && Date.now() - cacheAt < TTL) return cache;
  const stocks = await fetchNifty500Live(log);
  cache = stocks; cacheAt = Date.now();
  return stocks;
};
