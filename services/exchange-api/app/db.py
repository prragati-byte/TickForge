"""Trade storage. Uses the Rust database `tickforge_db`; tests may use an in-memory stand-in."""
from __future__ import annotations

import logging
import os

from app.config import Settings

log = logging.getLogger("exchange-api.db")

_FIELDS = ("trade_id", "symbol", "price_cents", "quantity", "buy_order_id", "sell_order_id",
           "buyer_id", "seller_id", "timestamp_ms")


class MemoryDB:
    """Same methods as tickforge_db.TickForgeDB, for tests only (TICKFORGE_MEMORY_DB=1)."""

    def __init__(self) -> None:
        self._trades: dict[int, dict] = {}

    def insert_trade(self, **fields) -> None:
        if set(fields) != set(_FIELDS):
            raise ValueError(f"expected exactly {_FIELDS}")
        self._trades[fields["trade_id"]] = dict(fields)

    def get_trade(self, trade_id: int):
        return self._trades.get(trade_id)

    def range(self, start_ms: int, end_ms: int, symbol: str | None = None) -> list[dict]:
        rows = [t for t in self._trades.values()
                if start_ms <= t["timestamp_ms"] < end_ms and (symbol is None or t["symbol"] == symbol)]
        return sorted(rows, key=lambda t: (t["timestamp_ms"], t["trade_id"]))

    def count(self) -> int:
        return len(self._trades)

    def flush(self) -> None:
        pass

    def compact(self) -> int:
        return 0


def open_db(settings: Settings):
    """Open the trade database. A missing tickforge_db module is a startup error."""
    if settings.memory_db:
        log.warning("using the in-memory trade store (TICKFORGE_MEMORY_DB=1): trades are not saved")
        return MemoryDB()
    try:
        from tickforge_db import TickForgeDB
    except ImportError as exc:
        raise RuntimeError(
            "tickforge_db is not installed. Build it with ./build.sh "
            "(or: maturin develop --release in storage/). "
            "For tests only you can set TICKFORGE_MEMORY_DB=1."
        ) from exc
    path = os.path.join(settings.data_dir, "trades-db")
    os.makedirs(path, exist_ok=True)
    log.info("trade database at %s", path)
    return TickForgeDB(path)
