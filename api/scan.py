# api/scan.py — Vercel Python serverless function
# Uses yfinance which handles Yahoo Finance auth automatically
# GET /api/scan?symbol=RELIANCE

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json, yfinance as yf

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        symbol_raw = (params.get("symbol", [""])[0]).strip().upper()

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        if not symbol_raw:
            self.wfile.write(json.dumps({"error": "symbol param required"}).encode())
            return

        # yfinance uses .NS suffix for NSE stocks
        ticker_sym = symbol_raw if symbol_raw.endswith(".NS") else f"{symbol_raw}.NS"

        try:
            ticker = yf.Ticker(ticker_sym)
            hist   = ticker.history(period="1y", interval="1d", auto_adjust=True)

            if hist.empty:
                self.wfile.write(json.dumps({
                    "error": f"No data for {ticker_sym} — check the NSE ticker symbol"
                }).encode())
                return

            candles = []
            for ts, row in hist.iterrows():
                candles.append({
                    "date":   ts.strftime("%Y-%m-%d"),
                    "open":   round(float(row["Open"]),  2),
                    "high":   round(float(row["High"]),  2),
                    "low":    round(float(row["Low"]),   2),
                    "close":  round(float(row["Close"]), 2),
                    "volume": int(row["Volume"]),
                })

            if len(candles) < 60:
                self.wfile.write(json.dumps({
                    "error": f"Only {len(candles)} candles for {symbol_raw} — need 60+"
                }).encode())
                return

            self.wfile.write(json.dumps({
                "symbol":  symbol_raw,
                "candles": candles,
            }).encode())

        except Exception as e:
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()
