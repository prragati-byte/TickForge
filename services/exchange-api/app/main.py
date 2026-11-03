"""exchange-api (port 8001): the glue between the browser, the matching engine and the database.

Run:  uvicorn app.main:app --port 8001      (from services/exchange-api/)
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from app import routes
from app.config import Settings
from app.db import open_db
from app.engine_client import EngineClient, EngineDown, Rejected
from app.symbols import ALL_SYMBOLS, DEFAULT_SYMBOL, START_PRICES, SYMBOL_BY_ID, SYMBOL_IDS
from app.traders import make_order, make_traders

log = logging.getLogger("exchange-api")

SPEEDS = (1, 10, 100)
STATS_NUMBERS = ["uptime_s", "submitted", "processed", "queue_depth", "orders_per_sec", "trades_total",
                 "trades_per_sec", "avg_latency_us", "p50_latency_us", "p99_latency_us", "cpu_pct",
                 "rss_mb", "threads"]
STATS_LISTS = ["lat_hist", "producers"]


class Exchange:
    """All live state of the API: traders, recent trades, order books and WebSocket clients."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.prices: dict[str, int] = dict(START_PRICES)  # last trade price per symbol, cents
        self.traders = make_traders(self.prices)
        self.engine = EngineClient(settings.engine_host, settings.engine_port, settings.reconnect_seconds)
        self.engine.on_trade = self._on_trade
        self.store = None
        self.recent_trades: deque[dict] = deque(maxlen=500)  # newest first
        self.books: dict[str, dict] = {s: {"symbol": s, "bids": [], "asks": []} for s in ALL_SYMBOLS}
        self.state = "running" if settings.traders_start_running else "stopped"
        self.speed = 1
        self.rng = random.Random()
        self.notice = ""  # one-off message shown in the next telemetry status

        self._persist_queue: asyncio.Queue  # created in start(), inside the running event loop
        self._db_pool = ThreadPoolExecutor(max_workers=1)  # the database is used from one thread only
        self._tasks: list[asyncio.Task] = []
        self._telemetry_trades: deque[dict] = deque(maxlen=50)
        self._last_status = ""
        self._last_sent: dict = {}
        self.trade_clients: set[WebSocket] = set()
        self.trader_clients: set[WebSocket] = set()
        self.telemetry_clients: set[WebSocket] = set()
        self.book_clients: dict[WebSocket, str] = {}  # websocket -> symbol it watches

    # ---- start / stop -------------------------------------------------------------------------
    async def start(self) -> None:
        self.store = open_db(self.settings)  # raises if tickforge_db is missing
        self._persist_queue = asyncio.Queue()
        self.engine.start()
        self._tasks = [asyncio.create_task(self._persist_loop()),
                       asyncio.create_task(self._order_loop()),
                       asyncio.create_task(self._tick_loop())]

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        await self.engine.stop()
        self._db_pool.shutdown(wait=True)

    async def db(self, fn, *args):
        """Run a database call on the single database thread."""
        return await asyncio.get_running_loop().run_in_executor(self._db_pool, fn, *args)

    # ---- trades -------------------------------------------------------------------------------
    def _on_trade(self, msg: dict) -> None:
        """Called by the engine client for every trade. Moves cash and shares between the real traders."""
        symbol = SYMBOL_BY_ID.get(msg["symbol_id"])
        if symbol is None:
            log.warning("trade for unknown symbol_id %s", msg["symbol_id"])
            return
        price, qty = msg["price"], msg["qty"]
        self.prices[symbol] = price
        for trader_id, side in ((msg["buyer_id"], "BUY"), (msg["seller_id"], "SELL")):
            if 1 <= trader_id <= len(self.traders):  # id 0 = a manual order, it has no account
                self.traders[trader_id - 1].apply_fill(symbol, side, price, qty)
        trade = {
            "trade_id": msg["trade_id"], "symbol": symbol, "price": price, "qty": qty,
            "buy_order_id": msg["buy_order_id"], "sell_order_id": msg["sell_order_id"],
            "buyer_id": msg["buyer_id"], "seller_id": msg["seller_id"],
            "taker_side": msg.get("taker_side", ""), "ts_ms": msg.get("ts_ms") or int(time.time() * 1000),
        }
        self.recent_trades.appendleft(trade)
        self._telemetry_trades.append(
            {"id": trade["trade_id"], "price": price, "qty": qty, "buy": trade["buyer_id"], "sell": trade["seller_id"]})
        self._persist_queue.put_nowait(trade)

    def _insert_trade(self, trade: dict) -> None:
        self.store.insert_trade(
            trade_id=trade["trade_id"], symbol=trade["symbol"], price_cents=trade["price"],
            quantity=trade["qty"], buy_order_id=trade["buy_order_id"], sell_order_id=trade["sell_order_id"],
            buyer_id=trade["buyer_id"], seller_id=trade["seller_id"], timestamp_ms=trade["ts_ms"])

    async def _persist_loop(self) -> None:
        """Save each trade to the database, then push it to /ws/trades clients."""
        while True:
            trade = await self._persist_queue.get()
            try:
                await self.db(self._insert_trade, trade)
            except Exception:
                log.exception("could not save trade %s", trade["trade_id"])
            await self._send(self.trade_clients, json.dumps(trade))

    # ---- orders -------------------------------------------------------------------------------
    async def place_order(self, trader_id: int, symbol: str, side: str, price: int, qty: int) -> int:
        """Send one order to the engine. Raises EngineDown or Rejected."""
        return await self.engine.new_order(trader_id, SYMBOL_IDS[symbol], side, price, qty)

    async def _order_loop(self) -> None:
        """The virtual traders: one random trader sends one order each round."""
        while True:
            rate = self.settings.orders_per_second * self.speed
            await asyncio.sleep(1 / rate if rate > 0 else 1)
            if self.state != "running" or not self.engine.connected:
                continue
            trader = self.rng.choice(self.traders)
            order = make_order(trader, self.prices, self.rng)
            if order is None:
                continue
            symbol, side, price, qty = order
            try:
                await self.place_order(trader.trader_id, symbol, side, price, qty)
            except (EngineDown, Rejected, asyncio.TimeoutError) as exc:
                log.debug("order by trader %s not placed: %r", trader.trader_id, exc)

    async def reset_traders(self) -> None:
        """Cancel the traders' open orders, then give every trader the starting cash and shares."""
        for order_id in list(self.engine.owners):
            try:
                await self.engine.cancel(order_id)
            except (EngineDown, Rejected, asyncio.TimeoutError):
                self.engine.owners.pop(order_id, None)
        for trader in self.traders:
            trader.reset(self.prices)

    # ---- order books --------------------------------------------------------------------------
    async def get_book(self, symbol: str) -> dict:
        """Live book from the engine; the last known book if the engine is unreachable."""
        if self.engine.connected:
            try:
                reply = await self.engine.command("book", symbol_id=SYMBOL_IDS[symbol], depth=10)
                self.books[symbol] = {"symbol": symbol, "bids": reply.get("bids", []), "asks": reply.get("asks", [])}
            except (EngineDown, asyncio.TimeoutError):
                pass
        return self.books[symbol]

    def traders_snapshot(self) -> dict:
        return {"traders": [t.to_dict(self.prices) for t in self.traders]}

    # ---- telemetry ----------------------------------------------------------------------------
    def status_message(self) -> dict:
        if not self.engine.connected:
            error = f"engine not reachable at {self.settings.engine_host}:{self.settings.engine_port}"
            return {"type": "status", "state": "closed", "error": error}
        return {"type": "status", "state": self.state, "error": self.notice}

    async def stats_message(self) -> dict:
        stats = await self.engine.command("stats")
        book = self.books[DEFAULT_SYMBOL]
        msg = {"type": "stats", "speed": self.speed}
        msg.update({k: stats.get(k, 0) for k in STATS_NUMBERS})
        msg.update({k: stats.get(k, []) for k in STATS_LISTS})
        msg["book"] = {"bids": book["bids"], "asks": book["asks"]}
        msg["trades"] = list(self._telemetry_trades)
        self._telemetry_trades.clear()
        return msg

    async def handle_command(self, cmd: dict) -> None:
        """A command from the browser (see docs/CONTRACTS.md section 5)."""
        name = cmd.get("cmd")
        if name in ("start", "pause", "stop"):
            self.state = {"start": "running", "pause": "paused", "stop": "stopped"}[name]
        elif name == "reset":
            await self.reset_traders()
        elif name == "speed":
            if cmd.get("value") in SPEEDS:
                self.speed = cmd["value"]
        elif name == "order":
            await self._manual_order(cmd)
        else:
            return
        await self._send_status()

    async def _manual_order(self, cmd: dict) -> None:
        side, qty, price = cmd.get("side"), cmd.get("qty"), cmd.get("price")
        ok = side in ("BUY", "SELL") and all(isinstance(v, int) and not isinstance(v, bool) and v > 0 for v in (qty, price))
        if not ok:
            self.notice = "order not sent: side, qty and price (in cents) are required"
            return
        try:
            await self.place_order(0, DEFAULT_SYMBOL, side, price, qty)
        except Rejected as exc:
            self.notice = f"order rejected: {exc.reason}"
        except (EngineDown, asyncio.TimeoutError):
            self.notice = "order not sent: engine not reachable"

    async def _send_status(self) -> None:
        text = json.dumps(self.status_message())
        self.notice = ""
        if text != self._last_status:
            self._last_status = text
            await self._send(self.telemetry_clients, text)

    # ---- pushing to WebSocket clients ---------------------------------------------------------
    async def _send_one(self, ws: WebSocket, text: str) -> None:
        try:
            await ws.send_text(text)
        except Exception:
            self.forget(ws)  # the browser went away

    async def _send(self, clients: set, text: str) -> None:
        for ws in list(clients):
            await self._send_one(ws, text)

    def forget(self, ws: WebSocket) -> None:
        """Remove a WebSocket client from every list."""
        self.trade_clients.discard(ws)
        self.trader_clients.discard(ws)
        self.telemetry_clients.discard(ws)
        self.book_clients.pop(ws, None)
        for key in [k for k in self._last_sent if k[0] is ws]:
            del self._last_sent[key]

    async def push_changed(self, ws: WebSocket, key: str, payload: dict) -> None:
        """Send `payload` to one client unless it already has exactly this."""
        text = json.dumps(payload)
        if self._last_sent.get((ws, key)) != text:
            self._last_sent[(ws, key)] = text
            await self._send_one(ws, text)

    async def _tick_loop(self) -> None:
        """Every tick: refresh books, then push whatever changed."""
        while True:
            await asyncio.sleep(self.settings.tick_seconds)
            try:
                await self.tick()
            except Exception:
                log.exception("tick failed")

    async def tick(self) -> None:
        await self._send_status()
        if self.engine.connected:
            try:
                for symbol in ALL_SYMBOLS:
                    await self.get_book(symbol)
                if self.telemetry_clients:
                    await self._send(self.telemetry_clients, json.dumps(await self.stats_message()))
            except (EngineDown, asyncio.TimeoutError):
                pass
        if not self.telemetry_clients:
            self._telemetry_trades.clear()
        for ws, symbol in list(self.book_clients.items()):
            await self.push_changed(ws, "book", self.books[symbol])
        snapshot = self.traders_snapshot()
        for ws in list(self.trader_clients):
            await self.push_changed(ws, "traders", snapshot)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    exchange = Exchange(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await exchange.start()
        yield
        await exchange.stop()

    app = FastAPI(title="TickForge exchange-api", lifespan=lifespan)
    app.state.exchange = exchange
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:8443", "http://127.0.0.1:8443"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(routes.router)
    return app


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
app = create_app()
