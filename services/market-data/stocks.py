from __future__ import annotations

import math
import re
import time
from datetime import datetime, timezone

import yfinance as yf

from journey import compute_journey

SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-^=]{1,12}$")
# The only (range -> interval) pairs the API will forward to Yahoo. The interval is fixed per range,
# so a client cannot ask for combinations Yahoo rejects or for unbounded amounts of data.
RANGE_TO_INTERVAL = {"1d": "5m", "5d": "15m", "1mo": "1d", "6mo": "1d", "1y": "1d"}
CACHE_TTL_SECONDS = 30
CACHE_MAX_ENTRIES = 200
STALE_BAR_SECONDS = 20 * 60  # last bar older than this => market treated as closed

_cache: dict = {}


class StockNotFound(Exception):
    pass


class InvalidSymbol(Exception):
    pass


class InvalidParameter(Exception):
    pass


def _validate(symbol: str, range: str, interval: str | None = None) -> str:
    if not SYMBOL_RE.match(symbol):
        raise InvalidSymbol(symbol)
    if range not in RANGE_TO_INTERVAL:
        raise InvalidParameter(f"range must be one of {', '.join(RANGE_TO_INTERVAL)}")
    if interval is not None and interval != RANGE_TO_INTERVAL[range]:
        raise InvalidParameter(f"interval for range {range} must be {RANGE_TO_INTERVAL[range]}")
    return symbol.upper()


def _cache_get(key):
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_TTL_SECONDS:
        return hit[1]
    return None


def _cache_put(key, value) -> None:
    _cache[key] = (time.monotonic(), value)
    while len(_cache) > CACHE_MAX_ENTRIES:  # bounded: drop the oldest entry
        _cache.pop(next(iter(_cache)))


def _market_state(last_bar_time) -> str:
    """Heuristic: if the newest bar is fresh the market is trading, else closed."""
    try:
        age = (datetime.now(timezone.utc) - last_bar_time.to_pydatetime()).total_seconds()
    except Exception:
        return "UNKNOWN"
    return "REGULAR" if age <= STALE_BAR_SECONDS else "CLOSED"


def _fast_info(ticker, key):
    try:
        return ticker.fast_info[key]
    except Exception:
        return None


def _currency(ticker) -> str:
    value = _fast_info(ticker, "currency")
    return value if isinstance(value, str) and value else "USD"


def _finite_or_none(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _previous_close(ticker, fallback: float) -> float:
    daily = ticker.history(period="5d", interval="1d")
    if len(daily) >= 2:
        return float(daily["Close"].iloc[-2])
    return fallback


def _fetch(symbol: str, range: str, interval: str):
    ticker = yf.Ticker(symbol)
    history = ticker.history(period=range, interval=interval)
    if history.empty:
        raise StockNotFound(f"No data found for {symbol}")

    latest = history.iloc[-1]
    price = float(latest["Close"])
    previous_close = _previous_close(ticker, price)

    change = price - previous_close
    change_percent = (change / previous_close) * 100 if previous_close else 0.0

    return {
        "symbol": symbol,
        "currency": _currency(ticker),
        "price": price,
        "previousClose": previous_close,
        "change": change,
        "changePercent": change_percent,
        "volume": int(latest["Volume"]),
        "marketState": _market_state(history.index[-1]),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "history": [
            {
                "timestamp": timestamp.isoformat(),
                "open": float(row["Open"]),
                "high": float(row["High"]),
                "low": float(row["Low"]),
                "close": float(row["Close"]),
                "volume": int(row["Volume"]),
            }
            for timestamp, row in history.iterrows()
        ],
    }


def get_stock_data(symbol: str, range: str = "1d", interval: str = "5m"):
    symbol = _validate(symbol, range, interval)
    key = ("quote", symbol, range, interval)
    cached = _cache_get(key)
    if cached is not None:
        return cached
    data = _fetch(symbol, range, interval)
    _cache_put(key, data)
    return data


def get_journey_data(symbol: str, range: str = "1d"):
    symbol = _validate(symbol, range)
    interval = RANGE_TO_INTERVAL[range]
    key = ("journey", symbol, range)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    ticker = yf.Ticker(symbol)
    history = ticker.history(period=range, interval=interval)
    if history.empty:
        raise StockNotFound(f"No data found for {symbol}")

    previous_close = None
    if range == "1d":
        fallback = float(history["Close"].iloc[-1])
        previous_close = _previous_close(ticker, fallback)

    try:
        data = compute_journey(
            history,
            interval=interval,
            range_=range,
            previous_close=previous_close,
            currency=_currency(ticker),
            year_high=_finite_or_none(_fast_info(ticker, "year_high")),
            year_low=_finite_or_none(_fast_info(ticker, "year_low")),
            symbol=symbol,
        )
    except ValueError:
        raise StockNotFound(f"No usable price data for {symbol}")
    data["updatedAt"] = datetime.now(timezone.utc).isoformat()
    _cache_put(key, data)
    return data
