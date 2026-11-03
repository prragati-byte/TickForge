"""A tiny stand-in for the C++ engine, for tests. It speaks the JSON-lines protocol of
docs/CONTRACTS.md section 2 with a simple price-time matcher. It runs in its own thread."""
from __future__ import annotations

import asyncio
import json
import threading


class FakeEngine:
    def __init__(self, port: int) -> None:
        self.port = port
        self.loop: asyncio.AbstractEventLoop | None = None
        self.thread: threading.Thread | None = None
        self.server: asyncio.AbstractServer | None = None
        self.clients: list[asyncio.StreamWriter] = []
        self._ready = threading.Event()
        # State survives stop()/start(), like a real engine that keeps its book.
        self.seq = 0
        self.trade_id = 0
        self.books: dict[int, dict[str, list[dict]]] = {}  # symbol_id -> {"BUY": [...], "SELL": [...]}
        self.orders_seen = 0

    # ---- thread control -----------------------------------------------------------------------
    def start(self) -> None:
        self._ready.clear()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        assert self._ready.wait(5), "fake engine did not start"

    def stop(self) -> None:
        if self.loop.is_closed():
            return  # already stopped

        async def shutdown():
            self.server.close()
            for writer in self.clients:
                writer.close()
            self.clients.clear()
            await asyncio.sleep(0.1)  # let the sockets close before the loop stops
            asyncio.get_running_loop().stop()

        asyncio.run_coroutine_threadsafe(shutdown(), self.loop)
        self.thread.join(5)

    def _run(self) -> None:
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.server = self.loop.run_until_complete(asyncio.start_server(self._client, "127.0.0.1", self.port))
        self._ready.set()
        self.loop.run_forever()
        self.loop.close()

    # ---- protocol -----------------------------------------------------------------------------
    async def _client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.clients.append(writer)
        try:
            while line := await reader.readline():
                self._handle(json.loads(line), writer)
        except (ConnectionError, asyncio.CancelledError):
            pass

    @staticmethod
    def _send(writer: asyncio.StreamWriter, msg: dict) -> None:
        writer.write((json.dumps(msg) + "\n").encode())

    def _handle(self, msg: dict, writer: asyncio.StreamWriter) -> None:
        if msg["type"] == "new_order":
            self._new_order(msg, writer)
        elif msg["type"] == "cancel":
            self._cancel(msg, writer)
        elif msg["type"] == "command":
            name = msg["name"]
            if name == "book":
                self._send(writer, self._book(msg["symbol_id"]))
            elif name == "stats":
                self._send(writer, {"type": "stats", "uptime_s": 1.5, "submitted": self.orders_seen,
                                    "processed": self.orders_seen, "queue_depth": 0, "orders_per_sec": 10.0,
                                    "trades_total": self.trade_id, "trades_per_sec": 2.0, "avg_latency_us": 9.0,
                                    "p50_latency_us": 7.0, "p99_latency_us": 40.0, "lat_hist": [0] * 16,
                                    "producers": [self.orders_seen], "threads": 2, "cpu_pct": 1.0, "rss_mb": 10.0,
                                    "last_seq": self.seq, "state_hash": "0" * 16})

    def _new_order(self, msg: dict, writer: asyncio.StreamWriter) -> None:
        if msg["qty"] > 10_000:
            self._send(writer, {"type": "reject", "client_ref": msg["client_ref"], "reason": "max_qty"})
            return
        self.orders_seen += 1
        self.seq += 1
        order = {"id": self.seq, "side": msg["side"], "price": msg["price"], "qty": msg["qty"]}
        self._send(writer, {"type": "ack", "client_ref": msg["client_ref"], "order_id": order["id"], "seq": self.seq})
        book = self.books.setdefault(msg["symbol_id"], {"BUY": [], "SELL": []})
        opposite = book["SELL" if order["side"] == "BUY" else "BUY"]
        while order["qty"] > 0 and opposite:
            best = min(opposite, key=lambda o: (o["price"], o["id"])) if order["side"] == "BUY" else \
                min(opposite, key=lambda o: (-o["price"], o["id"]))
            crosses = best["price"] <= order["price"] if order["side"] == "BUY" else best["price"] >= order["price"]
            if not crosses:
                break
            qty = min(order["qty"], best["qty"])
            order["qty"] -= qty
            best["qty"] -= qty
            if best["qty"] == 0:
                opposite.remove(best)
            self.seq += 1
            self.trade_id += 1
            buy, sell = (order, best) if order["side"] == "BUY" else (best, order)
            trade = {"type": "trade", "trade_id": self.trade_id, "seq": self.seq, "symbol_id": msg["symbol_id"],
                     "price": best["price"], "qty": qty, "buy_order_id": buy["id"], "sell_order_id": sell["id"],
                     "taker_side": order["side"], "ts_ms": 1_767_225_600_000 + self.trade_id}
            for client in self.clients:
                self._send(client, trade)
        if order["qty"] > 0:
            book[order["side"]].append(order)

    def _cancel(self, msg: dict, writer: asyncio.StreamWriter) -> None:
        for book in self.books.values():
            for side in book.values():
                for order in side:
                    if order["id"] == msg["order_id"]:
                        side.remove(order)
                        self._send(writer, {"type": "ack", "client_ref": msg["client_ref"],
                                            "order_id": order["id"], "seq": self.seq})
                        return
        self._send(writer, {"type": "reject", "client_ref": msg["client_ref"], "reason": "unknown_order"})

    def _book(self, symbol_id: int) -> dict:
        book = self.books.get(symbol_id, {"BUY": [], "SELL": []})

        def levels(orders, descending):
            totals: dict[int, int] = {}
            for o in orders:
                totals[o["price"]] = totals.get(o["price"], 0) + o["qty"]
            return [[p, totals[p]] for p in sorted(totals, reverse=descending)]

        return {"type": "book", "symbol_id": symbol_id,
                "bids": levels(book["BUY"], True), "asks": levels(book["SELL"], False)}
