# I — Equity Scanner

Personal Indian equity market scanner dashboard.
Scans: Earnings Surprise · Relative Strength · Top Gainers · IPO Stocks

---

## Project Structure

```
eq-scanner/
├── index.html              ← Full frontend (single file)
├── vercel.json             ← Vercel routing + cache headers
├── package.json            ← Node dependencies
├── api/
│   ├── _utils.js           ← Shared: NSE fetch, Yahoo fetch, EMA, RS calc
│   ├── nifty500.js         ← GET /api/nifty500 — Nifty 500 constituent list
│   ├── earnings.js         ← GET /api/earnings — Scan 1
│   ├── rs.js               ← GET /api/rs — Scan 2
│   ├── gainers.js          ← GET /api/gainers — Scan 3
│   ├── ipo.js              ← GET /api/ipo — Scan 4
│   └── fundamentals.js     ← GET /api/fundamentals — MCap/PE/Sector enrichment
└── README.md
```

---

## Deployment on Vercel (Free, No Card Needed)

### Step 1 — Create GitHub Repository
1. Go to https://github.com and sign in (create free account if needed)
2. Click **New repository** → name it `eq-scanner` → **Create repository**
3. Upload all files from this folder to the repo
   - Drag and drop files in the GitHub web UI, OR
   - Use GitHub Desktop app (easier for beginners)

### Step 2 — Deploy on Vercel
1. Go to https://vercel.com → Sign up with GitHub (free)
2. Click **New Project** → **Import** your `eq-scanner` repo
3. Framework Preset: **Other**
4. Root Directory: leave as `/`
5. Click **Deploy**
6. Wait ~60 seconds

### Step 3 — Access Your Scanner
- Vercel gives you a URL like: `https://eq-scanner-yourname.vercel.app`
- Bookmark it. Works on any device, any browser.
- Every time you push changes to GitHub, Vercel auto-redeploys.

---

## Local Testing (Optional)

Install Vercel CLI:
```bash
npm install -g vercel
```

Run locally:
```bash
cd eq-scanner
npm install
vercel dev
```
Opens at http://localhost:3000

---

## API Endpoints

| Endpoint | Description | Params |
|---|---|---|
| GET /api/nifty500 | Nifty 500 stock list | — |
| GET /api/earnings | Earnings Surprise scan | rev_thresh, pat_thresh, mcap_min, mcap_max, price_min, pe_max, val_min |
| GET /api/rs | Relative Strength scan | rs_min, from_52wh, mcap_min, mcap_max, price_min, pe_max, val_min |
| GET /api/gainers | Top Gainers scan | period (daily/monthly/3month), price_min, mcap_min, mcap_max |
| GET /api/ipo | IPO Stocks scan | price_min, val_min |
| GET /api/fundamentals | Batch fundamentals | symbols (comma-separated, max 25) |

---

## Data Sources (All Free)

| Source | Used For |
|---|---|
| NSE India public API | Price data, gainers, IPO listings, Nifty 500 list |
| Screener.in | MCap, PE, Sector, Quarterly financials |
| Trendlyne | Latest quarterly results (Scan 1) |
| Yahoo Finance | Historical OHLC for RS and EMA calculation |

---

## Caching Strategy (Vercel Free Tier Safe)

| Endpoint | Cache TTL |
|---|---|
| Nifty 500 list | 6 hours |
| Earnings | 30 minutes |
| RS Rankings | 1 hour (expensive to compute) |
| Daily Gainers | 5 minutes |
| Monthly/3M Gainers | 30 minutes |
| IPO data | 1 hour |
| Fundamentals (per symbol) | 30 minutes |

Vercel free tier allows 100k function invocations/month and 100GB bandwidth.
This tool runs comfortably within those limits for personal daily use.

---

## Export Formats

**Zerodha Watchlist CSV:**
```
tradingsymbol
RELIANCE
INFY
TCS
```

**Upstox Watchlist CSV:**
```
trading_symbol
RELIANCE
INFY
TCS
```

---

## Notes on Data Accuracy

- NSE price data and Nifty 500 list: highly reliable
- RS Rating: calculated using MarketSmith 12-month weighted methodology
  (most recent quarter = 2x weight; other 3 quarters = 1x each)
- Screener.in scraping: ~95% coverage; may fail for some smallcaps
- Trendlyne results: public page, may change structure occasionally
- If any source fails, the scan shows an error with a Retry button
  (never shows wrong data silently)

---

## Watchlist Exclusion

Upload your previous watchlists (CSV files) before scanning.
- Auto-detects first column regardless of column header name
- Excluded symbols are stored in browser localStorage
- Symbols persist across sessions on same browser
- Clear anytime with the "Clear" button in the watchlist bar
