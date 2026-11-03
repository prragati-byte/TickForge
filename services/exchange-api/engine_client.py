"""
engine_client.py — asyncio client for the C++ engine_server Unix socket.

Usage:
    client = EngineClient()
    await client.connect()
    await client.submit_order(order_dict)
    # Trades are delivered via the on_trade callback.
"""

from __future__ import annotations
import asyncio
import json
import time
from typing import Callable, Awaitable, Any

SOCKET_PATH = "/tmp/tickforge_engine.sock"


class EngineClient:
    def __init__(self, socket_path: str = SOCKET_PATH) -> None:
        self._path = socket_path
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._callbacks: list[Callable[[dict], Awaitable[None]]] = []
        self._connected = False
        self._read_task: asyncio.Task | None = None

    def on_trade(self, cb: Callable[[dict], Awaitable[None]]) -> None:
        """Register an async callback that is called for every executed trade."""
        self._callbacks.append(cb)

    async def connect(self, retries: int = 20, delay: float = 0.5) -> None:
        """Connect to the engine_server socket, retrying until it's up."""
        for attempt in range(retries):
            try:
                self._reader, self._writer = await asyncio.open_unix_connection(self._path)
                self._connected = True
                self._read_task = asyncio.create_task(self._read_loop())
                print(f"[engine_client] Connected to {self._path}")
                return
            except (FileNotFoundError, ConnectionRefusedError):
                print(f"[engine_client] Waiting for engine_server ({attempt+1}/{retries})…")
                await asyncio.sleep(delay)
        raise RuntimeError(f"engine_server not available at {self._path} after {retries} attempts")

    async def submit_order(self, order: dict) -> None:
        """Send a single order JSON to the matching engine."""
        if not self._connected or self._writer is None:
            return
        line = json.dumps(order) + "\n"
        self._writer.write(line.encode())
        await self._writer.drain()

    async def _read_loop(self) -> None:
        """Background task: read trade lines from the engine and fire callbacks."""
        assert self._reader is not None
        partial = b""
        while True:
            try:
                chunk = await self._reader.read(4096)
                if not chunk:
                    self._connected = False
                    break
                partial += chunk
                while b"\n" in partial:
                    line, partial = partial.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        trade = json.loads(line.decode())
                        for cb in self._callbacks:
                            asyncio.create_task(cb(trade))
                    except json.JSONDecodeError:
                        pass
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"[engine_client] read error: {e}")
                self._connected = False
                break

    async def close(self) -> None:
        if self._read_task:
            self._read_task.cancel()
        if self._writer:
            self._writer.close()
            await self._writer.wait_closed()
        self._connected = False
