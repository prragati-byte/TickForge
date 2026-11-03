"""TCP client for the matching engine (JSON lines, see docs/CONTRACTS.md section 2).

The client keeps one connection open and reconnects when it drops. It also remembers which
trader owns each open order (learned from the `ack` replies), so a trade can be given to the
two real traders behind it.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Callable

log = logging.getLogger("exchange-api.engine")

REQUEST_TIMEOUT = 3.0


class EngineDown(Exception):
    """The engine is not connected."""


class Rejected(Exception):
    """The engine refused the request; `reason` is one of the contract's reject reasons."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class EngineClient:
    def __init__(self, host: str, port: int, reconnect_seconds: float = 1.0) -> None:
        self.host = host
        self.port = port
        self.reconnect_seconds = reconnect_seconds
        self.connected = False
        # Called (synchronously, in message order) for each `trade` message.
        self.on_trade: Callable[[dict], None] = lambda trade: None
        # order_id -> [trader_id, remaining quantity]. An entry is dropped when the order is
        # fully filled or cancelled.
        self.owners: dict[int, list[int]] = {}
        self._writer: asyncio.StreamWriter | None = None
        self._task: asyncio.Task | None = None
        self._next_ref = 0
        # client_ref -> (future, trader_id, qty) for orders waiting for ack/reject
        self._waiting: dict[int, tuple[asyncio.Future, int, int]] = {}
        # reply key ("book", symbol_id) / ("stats",) / ... -> future
        self._replies: dict[tuple, asyncio.Future] = {}

    # ---- connection ---------------------------------------------------------------------------
    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        self._drop_connection()

    async def _run(self) -> None:
        while True:
            try:
                reader, writer = await asyncio.open_connection(self.host, self.port, limit=1 << 20)
            except OSError:
                await asyncio.sleep(self.reconnect_seconds)
                continue
            self._writer = writer
            self.connected = True
            log.info("connected to engine at %s:%s", self.host, self.port)
            try:
                await self._read_loop(reader)
            except (OSError, asyncio.IncompleteReadError, ValueError) as exc:
                log.warning("engine connection error: %s", exc)
            finally:
                self._drop_connection()
            log.warning("engine connection lost; retrying")
            await asyncio.sleep(self.reconnect_seconds)

    def _drop_connection(self) -> None:
        self.connected = False
        if self._writer:
            self._writer.close()
            self._writer = None
        for future, _, _ in self._waiting.values():
            if not future.done():
                future.set_exception(EngineDown("connection lost"))
        for future in self._replies.values():
            if not future.done():
                future.set_exception(EngineDown("connection lost"))
        self._waiting.clear()
        self._replies.clear()

    async def _read_loop(self, reader: asyncio.StreamReader) -> None:
        while True:
            line = await reader.readline()
            if not line:
                return  # engine closed the connection
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                log.warning("ignoring a line that is not JSON: %r", line[:80])
                continue
            self._handle(msg)

    # ---- incoming messages --------------------------------------------------------------------
    def _handle(self, msg: dict) -> None:
        kind = msg.get("type")
        if kind == "ack":
            self._on_ack(msg)
        elif kind == "reject":
            waiting = self._waiting.pop(msg.get("client_ref"), None)
            if waiting and not waiting[0].done():
                waiting[0].set_exception(Rejected(str(msg.get("reason", "bad_request"))))
        elif kind == "trade":
            self._on_trade(msg)
        elif kind == "book":
            self._resolve(("book", msg.get("symbol_id")), msg)
        elif kind in ("stats", "state_hash"):
            self._resolve((kind,), msg)

    def _on_ack(self, msg: dict) -> None:
        waiting = self._waiting.pop(msg.get("client_ref"), None)
        if waiting is None:
            return
        future, trader_id, qty = waiting
        order_id = msg["order_id"]
        if qty > 0:  # a new order (a cancel ack has qty 0)
            self.owners[order_id] = [trader_id, qty]
        else:
            self.owners.pop(order_id, None)
        if not future.done():
            future.set_result(order_id)

    def _on_trade(self, msg: dict) -> None:
        # Look up both owners first, then shrink their remaining quantity.
        buyer = self.owners.get(msg["buy_order_id"])
        seller = self.owners.get(msg["sell_order_id"])
        for order_id, owner in ((msg["buy_order_id"], buyer), (msg["sell_order_id"], seller)):
            if owner is not None:
                owner[1] -= msg["qty"]
                if owner[1] <= 0:
                    del self.owners[order_id]
        msg["buyer_id"] = buyer[0] if buyer else 0
        msg["seller_id"] = seller[0] if seller else 0
        self.on_trade(msg)

    def _resolve(self, key: tuple, msg: dict) -> None:
        future = self._replies.pop(key, None)
        if future and not future.done():
            future.set_result(msg)

    # ---- outgoing requests --------------------------------------------------------------------
    def _send(self, message: dict) -> None:
        if not self.connected or self._writer is None:
            raise EngineDown("engine not connected")
        self._writer.write((json.dumps(message) + "\n").encode())

    async def _call(self, message: dict, trader_id: int = 0, qty: int = 0) -> int:
        """Send an order or cancel and wait for its ack (returns the order id) or reject."""
        self._next_ref += 1
        ref = self._next_ref
        future = asyncio.get_running_loop().create_future()
        self._waiting[ref] = (future, trader_id, qty)
        try:
            self._send({**message, "client_ref": ref})
            return await asyncio.wait_for(future, REQUEST_TIMEOUT)
        finally:
            self._waiting.pop(ref, None)

    async def new_order(self, trader_id: int, symbol_id: int, side: str, price: int, qty: int) -> int:
        return await self._call(
            {"type": "new_order", "symbol_id": symbol_id, "side": side, "price": price, "qty": qty},
            trader_id, qty,
        )

    async def cancel(self, order_id: int) -> int:
        return await self._call({"type": "cancel", "order_id": order_id})

    async def command(self, name: str, **args) -> dict:
        """Ask for `book`, `stats` or `state_hash` and wait for the reply."""
        key = ("book", args.get("symbol_id")) if name == "book" else (name,)
        future = self._replies.get(key)
        if future is None:  # nobody is already waiting for the same reply
            self._send({"type": "command", "name": name, **args})
            future = asyncio.get_running_loop().create_future()
            self._replies[key] = future
        try:
            return await asyncio.wait_for(asyncio.shield(future), REQUEST_TIMEOUT)
        except asyncio.TimeoutError:
            self._replies.pop(key, None)
            raise
