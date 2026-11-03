"""HTTP and WebSocket routes (see docs/CONTRACTS.md section 5)."""
from __future__ import annotations

import asyncio
import json
import time

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.engine_client import EngineDown, Rejected
from app.symbols import ALL_SYMBOLS, DEFAULT_SYMBOL, SYMBOL_IDS

router = APIRouter()


class OrderIn(BaseModel):
    trader_id: int = 0  # 0 = a manual order, not one of the 24 virtual traders
    symbol: str
    side: str
    price: int  # cents
    qty: int


def _exchange(request: Request):
    return request.app.state.exchange


def _check_symbol(symbol: str) -> str:
    if symbol not in SYMBOL_IDS:
        raise HTTPException(status_code=404, detail=f"unknown symbol {symbol}")
    return symbol


# ---- REST -----------------------------------------------------------------------------------------
@router.get("/health")
async def health(request: Request):
    ex = _exchange(request)
    return {
        "status": "ok",
        "engine": "connected" if ex.engine.connected else "disconnected",
        "trades": await ex.db(ex.store.count),
    }


@router.post("/orders")
async def post_order(order: OrderIn, request: Request):
    ex = _exchange(request)
    _check_symbol(order.symbol)
    if order.side not in ("BUY", "SELL") or order.price <= 0 or order.qty <= 0:
        raise HTTPException(status_code=422, detail="side must be BUY or SELL; price and qty must be positive")
    if not 0 <= order.trader_id <= len(ex.traders):
        raise HTTPException(status_code=422, detail="trader_id must be 0 to 24")
    try:
        order_id = await ex.place_order(order.trader_id, order.symbol, order.side, order.price, order.qty)
    except Rejected as exc:
        raise HTTPException(status_code=409, detail={"reason": exc.reason})
    except (EngineDown, asyncio.TimeoutError):
        raise HTTPException(status_code=503, detail="engine not reachable")
    return {"order_id": order_id}


@router.delete("/orders/{order_id}")
async def delete_order(order_id: int, request: Request):
    ex = _exchange(request)
    try:
        await ex.engine.cancel(order_id)
    except Rejected as exc:
        raise HTTPException(status_code=409, detail={"reason": exc.reason})
    except (EngineDown, asyncio.TimeoutError):
        raise HTTPException(status_code=503, detail="engine not reachable")
    return {"order_id": order_id}


@router.get("/orderbook")
async def get_orderbook(request: Request, symbol: str = DEFAULT_SYMBOL):
    return await _exchange(request).get_book(_check_symbol(symbol))


@router.get("/trades")
async def get_trades(request: Request, limit: int = 100):
    return {"trades": list(_exchange(request).recent_trades)[: max(0, limit)]}


@router.get("/trades/history")
async def get_history(request: Request, start_ms: int = 0, end_ms: int | None = None, symbol: str | None = None):
    ex = _exchange(request)
    if symbol is not None:
        _check_symbol(symbol)
    end = end_ms if end_ms is not None else int(time.time() * 1000) + 1
    return {"trades": await ex.db(ex.store.range, start_ms, end, symbol)}


@router.get("/traders")
async def get_traders(request: Request):
    return _exchange(request).traders_snapshot()


@router.get("/traders/{trader_id}")
async def get_trader(trader_id: int, request: Request):
    ex = _exchange(request)
    if not 1 <= trader_id <= len(ex.traders):
        raise HTTPException(status_code=404, detail="no such trader")
    return ex.traders[trader_id - 1].to_dict(ex.prices)


@router.get("/symbols")
async def get_symbols():
    return {"symbols": [{"symbol": s, "id": SYMBOL_IDS[s]} for s in ALL_SYMBOLS]}


# ---- WebSockets -----------------------------------------------------------------------------------
async def _wait_until_closed(ws: WebSocket, ex) -> None:
    """Keep the socket open and ignore what the client sends, until it disconnects."""
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        ex.forget(ws)


@router.websocket("/ws/trades")
async def ws_trades(ws: WebSocket):
    ex = ws.app.state.exchange
    await ws.accept()
    await ws.send_text(json.dumps({"type": "history", "trades": list(ex.recent_trades)[:50]}))
    ex.trade_clients.add(ws)
    await _wait_until_closed(ws, ex)


@router.websocket("/ws/orderbook")
async def ws_orderbook(ws: WebSocket, symbol: str = DEFAULT_SYMBOL):
    ex = ws.app.state.exchange
    await ws.accept()
    if symbol not in SYMBOL_IDS:
        await ws.close(code=1008)
        return
    ex.book_clients[ws] = symbol
    await ex.push_changed(ws, "book", await ex.get_book(symbol))
    await _wait_until_closed(ws, ex)


@router.websocket("/ws/traders")
async def ws_traders(ws: WebSocket):
    ex = ws.app.state.exchange
    await ws.accept()
    ex.trader_clients.add(ws)
    await ex.push_changed(ws, "traders", ex.traders_snapshot())
    await _wait_until_closed(ws, ex)


@router.websocket("/ws/telemetry")
async def ws_telemetry(ws: WebSocket):
    ex = ws.app.state.exchange
    await ws.accept()
    ex.telemetry_clients.add(ws)
    await ws.send_text(json.dumps(ex.status_message()))
    try:
        while True:
            try:
                cmd = json.loads(await ws.receive_text())
            except json.JSONDecodeError:
                continue
            if isinstance(cmd, dict):
                await ex.handle_command(cmd)
    except WebSocketDisconnect:
        pass
    finally:
        ex.forget(ws)
