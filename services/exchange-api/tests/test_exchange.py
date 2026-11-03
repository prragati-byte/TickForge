"""exchange-api tests, run against the fake engine in tests/fake_engine.py."""
import importlib.util
import random

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.symbols import ALL_SYMBOLS, START_PRICES
from app.traders import START_CASH, START_SHARES, Trader
from tests.conftest import order, wait_for

TELEMETRY_KEYS = {
    "type", "uptime_s", "speed", "submitted", "processed", "queue_depth", "orders_per_sec", "trades_total",
    "trades_per_sec", "avg_latency_us", "p50_latency_us", "p99_latency_us", "cpu_pct", "rss_mb", "threads",
    "lat_hist", "producers", "book", "trades",
}


def trader(client, trader_id):
    return client.get(f"/traders/{trader_id}").json()


# ---- fills go to the real buyer and seller ------------------------------------------------------
def test_fill_moves_cash_and_shares_between_the_two_owners(client):
    assert order(client, 3, "SELL", 19000, 100).status_code == 200
    assert order(client, 7, "BUY", 19000, 100).status_code == 200
    wait_for(lambda: trader(client, 7)["trades"] == 1)

    buyer, seller = trader(client, 7), trader(client, 3)
    assert buyer["cash"] == START_CASH - 19000 * 100
    assert buyer["holdings"]["AAPL"] == START_SHARES + 100
    assert seller["cash"] == START_CASH + 19000 * 100
    assert seller["holdings"]["AAPL"] == START_SHARES - 100
    # trader 3 started with shares valued at the 18950 start price and sold at 19000
    assert seller["realized_pnl"] == (19000 - START_PRICES["AAPL"]) * 100
    assert buyer["realized_pnl"] == 0
    others = [trader(client, i) for i in (1, 2, 4)]
    assert all(t["cash"] == START_CASH and t["trades"] == 0 for t in others)


def test_cash_and_shares_are_conserved_over_many_random_trades(client):
    rng = random.Random(1)
    for _ in range(60):
        r = order(client, rng.randint(1, 24), rng.choice(["BUY", "SELL"]), rng.randint(18900, 19000),
                  rng.randint(1, 50), symbol=rng.choice(ALL_SYMBOLS[:3]))
        assert r.status_code == 200
    trades = wait_for(lambda: client.get("/trades?limit=500").json()["trades"])
    wait_for(lambda: sum(t["trades"] for t in client.get("/traders").json()["traders"]) == 2 * len(
        client.get("/trades?limit=500").json()["trades"]))
    assert len(trades) > 5, "the random orders should have produced some trades"

    everyone = client.get("/traders").json()["traders"]
    assert sum(t["cash"] for t in everyone) == 24 * START_CASH
    for symbol in ALL_SYMBOLS:
        assert sum(t["holdings"].get(symbol, 0) for t in everyone) == 24 * START_SHARES
    # so total value is conserved for any set of prices
    prices = {s: 12345 + i for i, s in enumerate(ALL_SYMBOLS)}
    value = sum(t["cash"] + sum(q * prices[s] for s, q in t["holdings"].items()) for t in everyone)
    assert value == 24 * START_CASH + 24 * START_SHARES * sum(prices.values())


def test_manual_orders_have_no_account_but_the_other_side_is_updated(client):
    order(client, 0, "SELL", 19000, 10)
    order(client, 5, "BUY", 19000, 10)
    wait_for(lambda: trader(client, 5)["trades"] == 1)
    assert trader(client, 5)["cash"] == START_CASH - 190000
    trade = client.get("/trades").json()["trades"][0]
    assert (trade["buyer_id"], trade["seller_id"]) == (5, 0)


def test_reject_and_bad_input(client):
    r = order(client, 1, "BUY", 19000, 20000)
    assert r.status_code == 409 and r.json()["detail"]["reason"] == "max_qty"
    assert order(client, 1, "HOLD", 19000, 1).status_code == 422
    assert order(client, 99, "BUY", 19000, 1).status_code == 422
    assert order(client, 1, "BUY", 19000, 1, symbol="NOPE").status_code == 404
    assert client.get("/traders/99").status_code == 404


def test_cancel(client):
    order_id = order(client, 2, "BUY", 18000, 10).json()["order_id"]
    assert client.delete(f"/orders/{order_id}").status_code == 200
    assert client.delete(f"/orders/{order_id}").status_code == 409
    assert client.get("/orderbook?symbol=AAPL").json()["bids"] == []


# ---- order book ---------------------------------------------------------------------------------
def test_order_book_endpoint_and_websocket_show_resting_orders(client):
    order(client, 1, "BUY", 18900, 40)
    order(client, 2, "BUY", 18900, 10)
    order(client, 3, "SELL", 19100, 70)
    book = client.get("/orderbook?symbol=AAPL").json()
    assert book == {"symbol": "AAPL", "bids": [[18900, 50]], "asks": [[19100, 70]]}
    assert client.get("/orderbook?symbol=NVDA").json()["bids"] == []

    with client.websocket_connect("/ws/orderbook?symbol=AAPL") as ws:
        assert ws.receive_json()["bids"] == [[18900, 50]]
        order(client, 4, "BUY", 18800, 5)
        update = ws.receive_json()  # pushed when the book changes
        assert update["bids"] == [[18900, 50], [18800, 5]]


def test_traders_websocket_pushes_changes(client):
    with client.websocket_connect("/ws/traders") as ws:
        first = ws.receive_json()
        assert len(first["traders"]) == 24
        order(client, 3, "SELL", 19000, 5)
        order(client, 7, "BUY", 19000, 5)
        while True:  # skip updates that were sent before the fill was applied
            update = ws.receive_json()
            if update["traders"][6]["trades"] == 1:
                break
        assert update["traders"][6]["cash"] == START_CASH - 19000 * 5


# ---- persistence --------------------------------------------------------------------------------
def test_every_trade_is_saved_once_with_the_real_trader_ids(client):
    for i in range(3):
        order(client, 10 + i, "SELL", 19000 + i, 10)
    order(client, 20, "BUY", 19010, 30)  # fills all three sells
    wait_for(lambda: client.get("/health").json()["trades"] == 3)

    saved = client.get("/trades/history").json()["trades"]
    assert len(saved) == 3
    assert {t["seller_id"] for t in saved} == {10, 11, 12}
    assert all(t["buyer_id"] == 20 and t["symbol"] == "AAPL" and t["quantity"] == 10 for t in saved)
    assert sorted(t["price_cents"] for t in saved) == [19000, 19001, 19002]
    assert client.get("/trades/history?symbol=TSLA").json()["trades"] == []
    assert client.get("/trades/history?start_ms=0&end_ms=1").json()["trades"] == []
    assert [t["trade_id"] for t in client.get("/trades").json()["trades"]] == [3, 2, 1]  # newest first


def test_trades_websocket_streams_new_trades(client):
    with client.websocket_connect("/ws/trades") as ws:
        assert ws.receive_json()["type"] == "history"
        order(client, 1, "SELL", 19000, 5)
        order(client, 2, "BUY", 19000, 5)
        trade = ws.receive_json()
        assert (trade["buyer_id"], trade["seller_id"], trade["price"], trade["qty"]) == (2, 1, 19000, 5)


def test_missing_database_module_is_a_startup_error(engine):
    if importlib.util.find_spec("tickforge_db"):
        pytest.skip("tickforge_db is installed")
    app = create_app(Settings(engine_port=engine.port, memory_db=False))
    with pytest.raises(RuntimeError, match="tickforge_db"):
        with TestClient(app):
            pass


# ---- telemetry ----------------------------------------------------------------------------------
def next_of_type(ws, kind):
    for _ in range(50):
        msg = ws.receive_json()
        if msg["type"] == kind:
            return msg
    pytest.fail(f"no {kind} message")


def test_telemetry_has_exactly_the_fields_the_frontend_parses(client):
    order(client, 1, "BUY", 18900, 40)
    order(client, 3, "SELL", 19000, 5)
    order(client, 7, "BUY", 19000, 5)
    with client.websocket_connect("/ws/telemetry") as ws:
        assert ws.receive_json() == {"type": "status", "state": "stopped", "error": ""}
        stats = next_of_type(ws, "stats")
        assert set(stats) == TELEMETRY_KEYS
        assert stats["speed"] == 1 and stats["book"]["bids"] == [[18900, 40]]
        assert len(stats["lat_hist"]) == 16 and stats["producers"] == [3]
        assert all(isinstance(stats[k], (int, float)) for k in TELEMETRY_KEYS - {"type", "lat_hist", "producers", "book", "trades"})


def test_telemetry_trades_batch_uses_trader_ids(client):
    with client.websocket_connect("/ws/telemetry") as ws:
        order(client, 3, "SELL", 19000, 5)
        order(client, 7, "BUY", 19000, 5)
        seen = []
        while not seen:
            seen = next_of_type(ws, "stats")["trades"]
        assert seen == [{"id": 1, "price": 19000, "qty": 5, "buy": 7, "sell": 3}]


def test_telemetry_commands(client):
    with client.websocket_connect("/ws/telemetry") as ws:
        ws.receive_json()
        ws.send_json({"cmd": "start"})
        assert next_of_type(ws, "status")["state"] == "running"
        ws.send_json({"cmd": "pause"})
        assert next_of_type(ws, "status")["state"] == "paused"
        ws.send_json({"cmd": "stop"})
        assert next_of_type(ws, "status")["state"] == "stopped"
        ws.send_json({"cmd": "speed", "value": 10})
        wait_for(lambda: client.app.state.exchange.speed == 10)
        assert next_of_type(ws, "stats")["speed"] == 10
        ws.send_json({"cmd": "speed", "value": 7})  # not one of 1, 10, 100: ignored
        ws.send_json({"cmd": "order", "side": "SELL", "qty": 25, "price": 19500})
        wait_for(lambda: client.get("/orderbook").json()["asks"] == [[19500, 25]])
        ws.send_json({"cmd": "order", "side": "BUY", "qty": 99999, "price": 19500})
        assert "max_qty" in next_of_type(ws, "status")["error"]
        assert client.app.state.exchange.speed == 10


def test_telemetry_reset_restores_traders_and_cancels_their_orders(client):
    order(client, 3, "SELL", 19000, 5)
    order(client, 7, "BUY", 19000, 5)
    order(client, 8, "BUY", 15000, 5)  # stays on the book
    wait_for(lambda: trader(client, 7)["trades"] == 1)
    with client.websocket_connect("/ws/telemetry") as ws:
        ws.send_json({"cmd": "reset"})
        wait_for(lambda: trader(client, 7)["trades"] == 0)
    assert trader(client, 7)["cash"] == START_CASH
    wait_for(lambda: client.get("/orderbook").json()["bids"] == [])


def test_virtual_traders_trade_by_themselves_when_running(engine):
    settings = Settings(engine_port=engine.port, memory_db=True, traders_start_running=True,
                        orders_per_second=200, tick_seconds=0.1, reconnect_seconds=0.1)
    with TestClient(create_app(settings)) as c:
        wait_for(lambda: c.get("/health").json()["trades"] >= 3, timeout=15)
        everyone = c.get("/traders").json()["traders"]
        assert sum(t["cash"] for t in everyone) == 24 * START_CASH


# ---- reconnect ----------------------------------------------------------------------------------
def test_client_reconnects_when_the_engine_comes_back(client, engine):
    with client.websocket_connect("/ws/telemetry") as ws:
        assert ws.receive_json()["state"] == "stopped"
        engine.stop()
        wait_for(lambda: client.get("/health").json()["engine"] == "disconnected")
        assert order(client, 1, "BUY", 19000, 1).status_code == 503
        status = next_of_type(ws, "status")
        assert status["state"] == "closed" and "not reachable" in status["error"]

        engine.start()
        wait_for(lambda: client.get("/health").json()["engine"] == "connected")
        assert order(client, 1, "BUY", 19000, 1).status_code == 200
        assert next_of_type(ws, "status")["state"] == "stopped"


# ---- trader accounts (no engine needed) -----------------------------------------------------------
def test_trader_average_cost_pnl_and_short_cover():
    t = Trader(1, "x", "random", cash=0)
    t.apply_fill("AAPL", "BUY", 100, 10)
    t.apply_fill("AAPL", "BUY", 200, 10)           # 20 shares, cost 3000, average 150
    t.apply_fill("AAPL", "SELL", 180, 10)          # sells half: +30 per share
    assert (t.holdings["AAPL"], t.cost["AAPL"], t.realized_pnl, t.cash) == (10, 1500, 300, -3000 + 1800)
    t.apply_fill("AAPL", "SELL", 180, 15)          # 10 held + 5 short; only the 10 held count for P&L
    assert (t.holdings["AAPL"], t.realized_pnl) == (-5, 600)
    t.apply_fill("AAPL", "BUY", 170, 5)            # buying the short back adds no cost basis
    assert (t.holdings["AAPL"], t.cost["AAPL"]) == (0, 0)
