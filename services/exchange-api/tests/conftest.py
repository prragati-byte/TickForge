import socket
import time

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from tests.fake_engine import FakeEngine


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for(condition, timeout: float = 5.0):
    """Poll until `condition()` returns something truthy (and return it), or fail."""
    end = time.time() + timeout
    while time.time() < end:
        value = condition()
        if value:
            return value
        time.sleep(0.02)
    pytest.fail("condition not met in time")


@pytest.fixture()
def engine():
    fake = FakeEngine(free_port())
    fake.start()
    yield fake
    fake.stop()


@pytest.fixture()
def client(engine):
    """The exchange-api talking to the fake engine, with virtual traders paused."""
    settings = Settings(engine_port=engine.port, memory_db=True, traders_start_running=False,
                        tick_seconds=0.1, reconnect_seconds=0.1)
    with TestClient(create_app(settings)) as c:
        wait_for(lambda: c.get("/health").json()["engine"] == "connected")
        yield c


def order(client, trader_id, side, price, qty, symbol="AAPL"):
    return client.post("/orders", json={"trader_id": trader_id, "symbol": symbol, "side": side,
                                        "price": price, "qty": qty})
