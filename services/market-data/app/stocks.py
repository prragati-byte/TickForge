"""Stock quotes and the Journey data, fetched from a provider and cached in memory."""
from __future__ import annotations

import concurrent.futures
import logging
import math
import re
import time
from datetime import datetime, timezone
from typing import Any, Protocol

import pandas as pd

from app.journey import compute_journey

log = logging.getLogger("market-data")

SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-^=]{1,12}$")
# The only (range -> interval) pairs the API will forward to Yahoo. The interval is fixed per range,
# so a client cannot ask for combinations Yahoo rejects or for unbounded amounts of data.
RANGE_TO_INTERVAL = {"1d": "5m", "5d": "15m", "1mo": "1d", "6mo": "1d", "1y": "1d"}
CACHE_TTL_SECONDS = 30
CACHE_MAX_ENTRIES = 200
STALE_BAR_SECONDS = 20 * 60  # last bar older than this => market treated as closed
PROVIDER_TIMEOUT_SECONDS = 10


class StockNotFound(Exception):
    pass


class InvalidSymbol(Exception):
    pass


class InvalidParameter(Exception):
    pass


class ProviderTimeout(Exception):
    pass


# ---- provider ---------------------------------------------------------------------------------------
class Provider(Protocol):
    """Where prices come from. Tests pass in a fake that has the same two methods."""

    def history(self, symbol: str, period: str, interval: str) -> pd.DataFrame: ...

    def info(self, symbol: str) -> dict[str, Any]:
        """Optional extras: currency, year_high, year_low. Missing keys are fine."""
        ...


_pool = concurrent.futures.ThreadPoolExecutor(max_workers=8)


def _with_timeout(fn):
    """Run a blocking Yahoo call, but stop waiting after PROVIDER_TIMEOUT_SECONDS."""
    future = _pool.submit(fn)
    try:
        return future.result(timeout=PROVIDER_TIMEOUT_SECONDS)
    except concurrent.futures.TimeoutError:
        raise ProviderTimeout(f"no answer in {PROVIDER_TIMEOUT_SECONDS}s") from None


class YahooProvider:
    """The real provider (yfinance). Every call is wrapped in a timeout."""

    def history(self, symbol: str, period: str, interval: str) -> pd.DataFrame:
        import yfinance as yf

        return _with_timeout(
            lambda: yf.Ticker(symbol).history(period=period, interval=interval, timeout=PROVIDER_TIMEOUT_SECONDS)
        )

    def info(self, symbol: str) -> dict[str, Any]:
        import yfinance as yf

        def read() -> dict[str, Any]:
            fast = yf.Ticker(symbol).fast_info
            return {key: fast[key] for key in ("currency", "year_high", "year_low")}

        try:
            return _with_timeout(read)
        except Exception:  # extras only: the chart still works without them
            log.warning("no extra info for %s", symbol)
            return {}


provider: Provider = YahooProvider()


def set_provider(new_provider: Provider) -> None:
    global provider
    provider = new_provider


# ---- cache ------------------------------------------------------------------------------------------
class TTLCache:
    """Small in-memory cache: entries expire after `ttl` seconds, the oldest is dropped when full."""

    def __init__(self, ttl: float, max_entries: int) -> None:
        self.ttl = ttl
        self.max_entries = max_entries
        self._items: dict = {}

    def get(self, key):
        hit = self._items.get(key)
        if hit and time.monotonic() - hit[0] < self.ttl:
            return hit[1]
        return None

    def put(self, key, value) -> None:
        self._items[key] = (time.monotonic(), value)
        while len(self._items) > self.max_entries:
            self._items.pop(next(iter(self._items)))

    def clear(self) -> None:
        self._items.clear()

    def __len__(self) -> int:
        return len(self._items)


cache = TTLCache(CACHE_TTL_SECONDS, CACHE_MAX_ENTRIES)


# ---- helpers ----------------------------------------------------------------------------------------
def _validate(symbol: str, range: str, interval: str | None = None) -> str:
    if not SYMBOL_RE.match(symbol):
        raise InvalidSymbol(symbol)
    if range not in RANGE_TO_INTERVAL:
        raise InvalidParameter(f"range must be one of {', '.join(RANGE_TO_INTERVAL)}")
    if interval is not None and interval != RANGE_TO_INTERVAL[range]:
        raise InvalidParameter(f"interval for range {range} must be {RANGE_TO_INTERVAL[range]}")
    return symbol.upper()


def _market_state(last_bar_time) -> str:
    """Heuristic: if the newest bar is fresh the market is trading, else closed."""
    try:
        age = (datetime.now(timezone.utc) - last_bar_time.to_pydatetime()).total_seconds()
    except Exception:
        return "UNKNOWN"
    return "REGULAR" if age <= STALE_BAR_SECONDS else "CLOSED"


def _finite_or_none(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _currency(info: dict[str, Any]) -> str:
    value = info.get("currency")
    return value if isinstance(value, str) and value else "USD"


def _previous_close(symbol: str, fallback: float) -> float:
    daily = provider.history(symbol, "5d", "1d")
    if len(daily) >= 2:
        return float(daily["Close"].iloc[-2])
    return fallback


# ---- public functions -------------------------------------------------------------------------------
def get_stock_data(symbol: str, range: str = "1d", interval: str = "5m"):
    symbol = _validate(symbol, range, interval)
    key = ("quote", symbol, range, interval)
    cached = cache.get(key)
    if cached is not None:
        return cached

    history = provider.history(symbol, range, interval)
    if history.empty:
        raise StockNotFound(f"No data found for {symbol}")

    latest = history.iloc[-1]
    price = float(latest["Close"])
    previous_close = _previous_close(symbol, price)
    change = price - previous_close
    change_percent = (change / previous_close) * 100 if previous_close else 0.0

    data = {
        "symbol": symbol,
        "currency": _currency(provider.info(symbol)),
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
    cache.put(key, data)
    return data


def get_journey_data(symbol: str, range: str = "1d"):
    symbol = _validate(symbol, range)
    interval = RANGE_TO_INTERVAL[range]
    key = ("journey", symbol, range)
    cached = cache.get(key)
    if cached is not None:
        return cached

    history = provider.history(symbol, range, interval)
    if history.empty:
        raise StockNotFound(f"No data found for {symbol}")

    previous_close = None
    if range == "1d":
        previous_close = _previous_close(symbol, float(history["Close"].iloc[-1]))

    info = provider.info(symbol)
    try:
        data = compute_journey(
            history,
            interval=interval,
            range_=range,
            previous_close=previous_close,
            currency=_currency(info),
            year_high=_finite_or_none(info.get("year_high")),
            year_low=_finite_or_none(info.get("year_low")),
            symbol=symbol,
        )
    except ValueError:
        raise StockNotFound(f"No usable price data for {symbol}")
    data["updatedAt"] = datetime.now(timezone.utc).isoformat()
    cache.put(key, data)
    return data
