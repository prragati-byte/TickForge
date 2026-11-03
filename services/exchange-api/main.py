"""
exchange-api/main.py — TickForge Exchange API (FastAPI, port 8001)

Endpoints:
  REST
    POST /orders            — submit a manual order from the frontend
    GET  /trades            — list all executed trades from the LSM DB
    GET  /traders           — current state of all 24 virtual traders
    GET  /orderbook         — live bid/ask depth snapshot
    GET  /health            — liveness probe

  WebSocket
    WS /ws/trades           — stream of executed trade JSON objects
    WS /ws/orderbook        — periodic order-book depth snapshots
    WS /ws/traders          — periodic trader-state snapshots
"""

from __future__ import annotations
import asyncio
import json
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import db_client
import traders as trader_module
from engine_client import EngineClient
from symbol_map import SYMBOL_MAP, SYMBOL_IDS, ALL_SYMBOLS

# ── Global state ───────────────────────────────────────────────────────────

engine_client = EngineClient()
_trade_id_counter = 0
_recent_trades: deque[dict] = deque(maxlen=500)
_order_book: dict[str, dict] = {
    sym: {"bids": [], "asks": []} for sym in ALL_SYMBOLS
}

# WebSocket subscriber sets
_trade_ws_clients: set[WebSocket] = set()
_ob_ws_clients: set[WebSocket] = set()
_trader_ws_clients: set[WebSocket] = set()


def _next_trade_id() -> int:
    global _trade_id_counter
    _trade_id_counter += 1
    return _trade_id_counter


# ── Trade callback (called by engine_client on every executed trade) ────────

async def _on_trade(raw: dict) -> None:
    """Persist trade to LSM DB, update trader portfolios, broadcast to WS."""
    symbol_id = raw.get("symbol_id", 1)
    symbol = SYMBOL_MAP.get(symbol_id, "AAPL")
    price = float(raw.get("price", 0))
    quantity = int(raw.get("quantity", 0))
    buy_order_id = int(raw.get("buy_order_id", 0))
    sell_order_id = int(raw.get("sell_order_id", 0))
    trade_id = int(raw.get("trade_id", _next_trade_id()))
    ts = int(time.time() * 1000)

    # Determine buyer/seller trader from the order book (best-effort)
    # For simplicity we assign the trade to a random active trader
    import random
    buyer = random.choice(trader_module.TRADERS)
    seller = random.choice([t for t in trader_module.TRADERS if t.trader_id != buyer.trader_id])

    # Update portfolios
    trader_module.apply_trade_to_trader(buyer, symbol, "BUY", price, quantity)
    trader_module.apply_trade_to_trader(seller, symbol, "SELL", price, quantity)

    # Persist to Rust LSM DB
    try:
        db_client.insert_trade(
            trade_id=trade_id,
            trader_id=buyer.trader_id,
            symbol=symbol,
            price_paise=int(price * 100),
            quantity=quantity,
            side="BUY",
            timestamp=ts,
            buy_order_id=buy_order_id,
            sell_order_id=sell_order_id,
        )
    except Exception as e:
        print(f"[exchange-api] DB insert error: {e}")

    trade_obj = {
        "trade_id": trade_id,
        "symbol": symbol,
        "price": round(price, 4),
        "quantity": quantity,
        "buyer": buyer.name,
        "seller": seller.name,
        "buyer_id": buyer.trader_id,
        "seller_id": seller.trader_id,
        "timestamp": ts,
        "buy_order_id": buy_order_id,
        "sell_order_id": sell_order_id,
    }
    _recent_trades.appendleft(trade_obj)

    # Broadcast to WebSocket clients
    msg = json.dumps(trade_obj)
    dead = set()
    for ws in list(_trade_ws_clients):
        try:
            await ws.send_text(msg)
        except Exception:
            dead.add(ws)
    _trade_ws_clients -= dead


async def _broadcast_orderbook() -> None:
    """Periodically send order book snapshots to all subscribed WS clients."""
    while True:
        await asyncio.sleep(1)
        if not _ob_ws_clients:
            continue
        msg = json.dumps(_order_book)
        dead = set()
        for ws in list(_ob_ws_clients):
            try:
                await ws.send_text(msg)
            except Exception:
                dead.add(ws)
        _ob_ws_clients -= dead


async def _broadcast_traders() -> None:
    """Periodically send trader snapshots to all subscribed WS clients."""
    prices = trader_module.get_prices()
    while True:
        await asyncio.sleep(2)
        if not _trader_ws_clients:
            continue
        prices = trader_module.get_prices()
        snapshot = [t.to_dict(prices) for t in trader_module.TRADERS]
        msg = json.dumps(snapshot)
        dead = set()
        for ws in list(_trader_ws_clients):
            try:
                await ws.send_text(msg)
            except Exception:
                dead.add(ws)
        _trader_ws_clients -= dead


# ── Lifespan (startup / shutdown) ─────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Register trade callback
    engine_client.on_trade(_on_trade)

    # Try to connect to C++ engine server
    try:
        await engine_client.connect(retries=30, delay=0.5)
    except RuntimeError as e:
        print(f"[exchange-api] WARNING: {e}")
        print("[exchange-api] Continuing without live matching engine (manual orders will be queued)")

    # Start virtual traders
    trader_tasks = await trader_module.start_all_traders(engine_client)

    # Start broadcast tasks
    ob_task = asyncio.create_task(_broadcast_orderbook())
    tr_task = asyncio.create_task(_broadcast_traders())

    yield  # ← application runs

    # Cleanup
    for t in trader_tasks:
        t.cancel()
    ob_task.cancel()
    tr_task.cancel()
    await engine_client.close()


# ── App ────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="TickForge Exchange API",
    description="Central exchange hub: matching engine bridge, LSM database, 24 virtual traders",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8443",
        "http://127.0.0.1:8443",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── REST endpoints ─────────────────────────────────────────────────────────

class OrderRequest(BaseModel):
    symbol: str
    side: str           # "BUY" or "SELL"
    price: float
    quantity: int
    trader_id: int = 0  # 0 = manual/anonymous


@app.get("/health")
def health():
    return {
        "status": "ok",
        "engine_connected": engine_client._connected,
        "trades_in_memory": len(_recent_trades),
        "db_trade_count": db_client.get_db().trade_count(),
    }


@app.post("/orders")
async def submit_order(req: OrderRequest):
    """Submit a manual order from the frontend."""
    if req.symbol not in SYMBOL_IDS:
        raise HTTPException(status_code=400, detail=f"Unknown symbol: {req.symbol}")
    if req.side not in ("BUY", "SELL"):
        raise HTTPException(status_code=400, detail="side must be BUY or SELL")
    if req.quantity <= 0 or req.price <= 0:
        raise HTTPException(status_code=400, detail="price and quantity must be positive")

    order = {
        "order_id": trader_module._next_order_id(),
        "symbol_id": SYMBOL_IDS[req.symbol],
        "side": req.side,
        "price": req.price,
        "quantity": req.quantity,
        "trader_id": req.trader_id,
    }
    await engine_client.submit_order(order)
    return {"status": "submitted", "order": order}


@app.get("/trades")
def get_trades(limit: int = 100):
    """Most recent executed trades (from in-memory ring buffer)."""
    return {"trades": list(_recent_trades)[:limit]}


@app.get("/trades/all")
def get_all_trades():
    """All trades persisted in the LSM database."""
    return {"trades": db_client.get_all_trades()}


@app.get("/traders")
def get_traders():
    """Current state of all 24 virtual traders."""
    prices = trader_module.get_prices()
    return {"traders": [t.to_dict(prices) for t in trader_module.TRADERS]}


@app.get("/traders/{trader_id}")
def get_trader(trader_id: int):
    if trader_id < 1 or trader_id > 24:
        raise HTTPException(status_code=404, detail="Trader not found")
    trader = trader_module.TRADERS[trader_id - 1]
    prices = trader_module.get_prices()
    return trader.to_dict(prices)


@app.get("/orderbook")
def get_orderbook(symbol: str = "AAPL"):
    return _order_book.get(symbol, {"bids": [], "asks": []})


@app.get("/symbols")
def get_symbols():
    return {"symbols": ALL_SYMBOLS}


# Update internal price (called by the frontend poll or a price-feed task)
@app.post("/prices")
def update_price(symbol: str, price: float):
    if symbol not in SYMBOL_IDS:
        raise HTTPException(status_code=400, detail=f"Unknown symbol: {symbol}")
    trader_module.update_price(symbol, price)
    return {"ok": True}


# ── WebSocket endpoints ────────────────────────────────────────────────────

@app.websocket("/ws/trades")
async def ws_trades(ws: WebSocket):
    await ws.accept()
    _trade_ws_clients.add(ws)
    # Send recent trade history immediately
    await ws.send_text(json.dumps({"type": "history", "trades": list(_recent_trades)[:50]}))
    try:
        while True:
            await ws.receive_text()  # keep alive
    except WebSocketDisconnect:
        pass
    finally:
        _trade_ws_clients.discard(ws)


@app.websocket("/ws/orderbook")
async def ws_orderbook(ws: WebSocket):
    await ws.accept()
    _ob_ws_clients.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _ob_ws_clients.discard(ws)


@app.websocket("/ws/traders")
async def ws_traders(ws: WebSocket):
    await ws.accept()
    _trader_ws_clients.add(ws)
    # Send current state immediately
    prices = trader_module.get_prices()
    await ws.send_text(json.dumps([t.to_dict(prices) for t in trader_module.TRADERS]))
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _trader_ws_clients.discard(ws)
