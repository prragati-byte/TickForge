"""
traders.py — 24 virtual traders for the TickForge mini exchange.

Each trader has a unique personality (aggressive / passive / random),
a portfolio of holdings per symbol, and a cash balance. They run as
asyncio background tasks, continuously submitting orders to the matching
engine. Trader state is exposed via the Exchange API to the frontend.
"""

from __future__ import annotations
import asyncio
import random
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Callable, Awaitable

from symbol_map import ALL_SYMBOLS, SYMBOL_IDS

if TYPE_CHECKING:
    from engine_client import EngineClient


# ── Trader definition ──────────────────────────────────────────────────────

STRATEGY_LABELS = ["aggressive", "passive", "random", "momentum", "contrarian", "scalper"]

TRADER_NAMES = [
    "Arjun Mehta",     "Priya Sharma",    "Rahul Verma",     "Sneha Gupta",
    "Vikram Singh",    "Anil Kumar",      "Deepa Nair",      "Rohan Patel",
    "Kavya Reddy",     "Suresh Iyer",     "Meera Joshi",     "Nikhil Rao",
    "Pooja Bansal",    "Amit Choudhary",  "Lakshmi Das",     "Sanjay Kapoor",
    "Ananya Bose",     "Kiran Pillai",    "Manish Tiwari",   "Swati Saxena",
    "Gaurav Malhotra", "Ritu Agarwal",    "Varun Khanna",    "Divya Menon",
]

assert len(TRADER_NAMES) == 24


@dataclass
class Trader:
    trader_id: int                              # 1–24
    name: str
    strategy: str
    cash: float = 100_000.0                     # USD
    holdings: dict[str, int] = field(default_factory=dict)  # symbol → shares
    trades_executed: int = 0
    pnl: float = 0.0
    last_action: str = "—"

    # Track cost basis per symbol for simple P&L
    cost_basis: dict[str, float] = field(default_factory=dict)

    def portfolio_value(self, prices: dict[str, float]) -> float:
        val = self.cash
        for sym, qty in self.holdings.items():
            val += qty * prices.get(sym, 0.0)
        return val

    def to_dict(self, prices: dict[str, float] | None = None) -> dict:
        prices = prices or {}
        return {
            "trader_id": self.trader_id,
            "name": self.name,
            "strategy": self.strategy,
            "cash": round(self.cash, 2),
            "holdings": dict(self.holdings),
            "trades_executed": self.trades_executed,
            "pnl": round(self.pnl, 2),
            "portfolio_value": round(self.portfolio_value(prices), 2),
            "last_action": self.last_action,
        }


# ── Shared state ───────────────────────────────────────────────────────────

TRADERS: list[Trader] = [
    Trader(
        trader_id=i + 1,
        name=TRADER_NAMES[i],
        strategy=STRATEGY_LABELS[i % len(STRATEGY_LABELS)],
    )
    for i in range(24)
]

# Latest known prices (updated by the exchange API from the market-data service)
_prices: dict[str, float] = {sym: 100.0 for sym in ALL_SYMBOLS}

_order_id_counter = 0


def update_price(symbol: str, price: float) -> None:
    _prices[symbol] = price


def get_prices() -> dict[str, float]:
    return dict(_prices)


# ── Order generation ───────────────────────────────────────────────────────

def _next_order_id() -> int:
    global _order_id_counter
    _order_id_counter += 1
    return _order_id_counter


def _generate_order(trader: Trader) -> dict | None:
    """Generate a randomised order for this trader based on their strategy."""
    symbol = random.choice(ALL_SYMBOLS)
    price = _prices.get(symbol, 100.0)
    if price <= 0:
        return None

    strategy = trader.strategy
    qty = 0
    side = "BUY"
    order_price = price

    if strategy == "aggressive":
        qty = random.randint(50, 300)
        side = random.choice(["BUY", "SELL"])
        # Cross the spread aggressively
        order_price = price * (1.005 if side == "BUY" else 0.995)

    elif strategy == "passive":
        qty = random.randint(10, 80)
        side = random.choice(["BUY", "SELL"])
        # Post limit orders away from the market
        order_price = price * (0.995 if side == "BUY" else 1.005)

    elif strategy == "momentum":
        qty = random.randint(20, 150)
        # Momentum: always buy (simplified)
        side = "BUY"
        order_price = price * 1.002

    elif strategy == "contrarian":
        qty = random.randint(20, 150)
        side = "SELL"
        order_price = price * 0.998

    elif strategy == "scalper":
        qty = random.randint(1, 30)
        side = random.choice(["BUY", "SELL"])
        order_price = price * random.uniform(0.999, 1.001)

    else:  # random
        qty = random.randint(5, 200)
        side = random.choice(["BUY", "SELL"])
        order_price = price * random.uniform(0.99, 1.01)

    # Don't sell what we don't have
    if side == "SELL" and trader.holdings.get(symbol, 0) < qty:
        side = "BUY"

    # Don't buy if not enough cash
    if side == "BUY" and trader.cash < order_price * qty:
        qty = max(1, int(trader.cash / order_price * 0.8))

    if qty == 0:
        return None

    trader.last_action = f"{side} {qty} {symbol} @ {order_price:.2f}"

    return {
        "order_id": _next_order_id(),
        "symbol_id": SYMBOL_IDS[symbol],
        "side": side,
        "price": round(order_price, 4),
        "quantity": qty,
        "trader_id": trader.trader_id,
        "_symbol": symbol,  # kept for DB persistence; stripped before sending to C++
    }


def apply_trade_to_trader(trader: Trader, symbol: str, side: str,
                           price: float, quantity: int) -> None:
    """Update trader portfolio and cash after an executed trade."""
    cost = price * quantity
    if side == "BUY":
        trader.cash -= cost
        trader.holdings[symbol] = trader.holdings.get(symbol, 0) + quantity
        old_basis = trader.cost_basis.get(symbol, 0.0)
        old_qty = trader.holdings.get(symbol, 0) - quantity
        trader.cost_basis[symbol] = ((old_basis * old_qty) + cost) / max(1, trader.holdings[symbol])
    else:
        trader.cash += cost
        basis = trader.cost_basis.get(symbol, price)
        trader.pnl += (price - basis) * quantity
        trader.holdings[symbol] = max(0, trader.holdings.get(symbol, 0) - quantity)
    trader.trades_executed += 1


# ── Background asyncio tasks ───────────────────────────────────────────────

async def trader_task(trader: Trader, client: "EngineClient",
                      interval_min: float = 0.5, interval_max: float = 2.0) -> None:
    """Continuously generate and submit orders for a single virtual trader."""
    while True:
        try:
            order = _generate_order(trader)
            if order and client._connected:
                # Remove the private _symbol key before sending to C++ engine
                payload = {k: v for k, v in order.items() if not k.startswith("_")}
                await client.submit_order(payload)
        except Exception as e:
            print(f"[trader {trader.trader_id}] error: {e}")

        await asyncio.sleep(random.uniform(interval_min, interval_max))


async def start_all_traders(client: "EngineClient") -> list[asyncio.Task]:
    """Launch all 24 trader tasks and return their Task handles."""
    tasks = []
    for trader in TRADERS:
        task = asyncio.create_task(trader_task(trader, client))
        tasks.append(task)
    print(f"[traders] {len(TRADERS)} virtual traders started")
    return tasks
