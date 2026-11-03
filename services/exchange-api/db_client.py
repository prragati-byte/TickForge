"""
db_client.py — wrapper around the tickforge_db PyO3 native extension.

If the Rust .so is not built yet, falls back to an in-memory list so the
Exchange API can still run during development.

Build the native module:
    cd tickforge-db && pip install maturin && maturin develop
"""

from __future__ import annotations
import time
from typing import Any

_DB_AVAILABLE = False
_db_instance = None

try:
    import tickforge_db          # type: ignore  — built by maturin
    _DB_AVAILABLE = True
    print("[db_client] Rust LSM database loaded ✓")
except ImportError:
    print("[db_client] WARNING: tickforge_db not found — falling back to in-memory store")


# ── In-memory fallback ────────────────────────────────────────────────────────

class _InMemoryDB:
    def __init__(self) -> None:
        self._trades: list[dict] = []

    def insert_trade(
        self,
        trade_id: int, trader_id: int, symbol: str,
        price_paise: int, quantity: int, side: str,
        timestamp: int, buy_order_id: int, sell_order_id: int,
    ) -> bool:
        self._trades.append({
            "trade_id":      trade_id,
            "trader_id":     trader_id,
            "symbol":        symbol,
            "price_paise":   price_paise,
            "price":         price_paise / 100.0,
            "quantity":      quantity,
            "side":          side,
            "timestamp":     timestamp,
            "buy_order_id":  buy_order_id,
            "sell_order_id": sell_order_id,
        })
        return True

    def get_all_trades(self) -> list[dict]:
        return list(self._trades)

    def get_trades_by_symbol(self, symbol: str) -> list[dict]:
        s = symbol.upper()
        return [t for t in self._trades if t["symbol"].upper() == s]

    def get_trades_in_range(self, start_ms: int, end_ms: int) -> list[dict]:
        return [t for t in self._trades if start_ms <= t["timestamp"] <= end_ms]

    def trade_count(self) -> int:
        return len(self._trades)

    def flush(self, path: str) -> None:
        import json, os
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w") as f:
            for t in self._trades:
                f.write(json.dumps(t) + "\n")


# ── Public API ────────────────────────────────────────────────────────────────

def get_db(wal_path: str = "data/wal.log") -> Any:
    """Return the singleton DB instance (Rust or in-memory fallback)."""
    global _db_instance
    if _db_instance is None:
        if _DB_AVAILABLE:
            _db_instance = tickforge_db.TickForgeDB(wal_path)
        else:
            _db_instance = _InMemoryDB()
    return _db_instance


def insert_trade(
    trade_id: int,
    trader_id: int,
    symbol: str,
    price_paise: int,
    quantity: int,
    side: str,
    timestamp: int,
    buy_order_id: int,
    sell_order_id: int,
    wal_path: str = "data/wal.log",
) -> bool:
    return get_db(wal_path).insert_trade(
        trade_id, trader_id, symbol, price_paise,
        quantity, side, timestamp, buy_order_id, sell_order_id,
    )


def get_all_trades(wal_path: str = "data/wal.log") -> list[dict]:
    return get_db(wal_path).get_all_trades()


def get_trades_by_symbol(symbol: str, wal_path: str = "data/wal.log") -> list[dict]:
    return get_db(wal_path).get_trades_by_symbol(symbol)


def get_trades_in_range(start_ms: int, end_ms: int, wal_path: str = "data/wal.log") -> list[dict]:
    return get_db(wal_path).get_trades_in_range(start_ms, end_ms)
