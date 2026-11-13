import logging
import os

import requests
from langchain_core.tools import tool

logger = logging.getLogger(__name__)

stock_api = os.getenv("STOCK_API_KEY")
STOCK_URL = "https://www.alphavantage.co/query"


@tool
def Stock_price(symbol: str):
    """fetch latest stock price for a given symbol (e.g. "AAPL", "TSLA")"""
    if not stock_api:
        return "The stock price service is not configured."
    try:
        # GLOBAL_QUOTE returns one small quote instead of ~100 intraday candles.
        resp = requests.get(
            STOCK_URL,
            params={"function": "GLOBAL_QUOTE", "symbol": symbol, "apikey": stock_api},
            timeout=10,
        )
        data = resp.json()
    except Exception as e:
        logger.warning("Stock request failed: %s", type(e).__name__)
        return "The stock price service could not be reached. Please try again later."

    quote = data.get("Global Quote") or {}
    if not quote:
        # Alpha Vantage reports rate limits and bad symbols in "Note"/"Information"/"Error Message".
        reason = data.get("Note") or data.get("Information") or data.get("Error Message")
        return f"No quote found for {symbol}." + (f" {reason}" if reason else "")

    return {
        "symbol": quote.get("01. symbol"),
        "price": quote.get("05. price"),
        "change": quote.get("09. change"),
        "change_percent": quote.get("10. change percent"),
        "open": quote.get("02. open"),
        "high": quote.get("03. high"),
        "low": quote.get("04. low"),
        "volume": quote.get("06. volume"),
        "latest_trading_day": quote.get("07. latest trading day"),
        "previous_close": quote.get("08. previous close"),
    }
