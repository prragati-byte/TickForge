"""
Tests for the Journey analytics and API.
Run:  pip install pytest httpx && python -m pytest -q      (inside market-data/)

Expected values are calculated by hand in the comments, not copied from the code's output.
"""
import json
import statistics
import sys
import types

import pandas as pd
import pytest

import journey
import stocks

# ---- fixture A: 10 five-minute bars, New York, 14 Oct 2026 --------------------------------------
#  idx:     0    1    2    3    4   5   6   7    8    9
C = [100, 102, 104, 101, 97, 95, 98, 103, 106, 105]
O = [100, 100, 102, 104, 101, 97, 96, 98, 103, 105]
V = [100] * 10
V[8] = 1000


def frame_a():
    idx = pd.date_range("2026-10-14 09:30", periods=10, freq="5min", tz="America/New_York")
    hi = [max(o, c) + 0.5 for o, c in zip(O, C)]
    lo = [min(o, c) - 0.5 for o, c in zip(O, C)]
    return pd.DataFrame({"Open": O, "High": hi, "Low": lo, "Close": C, "Volume": V}, index=idx).astype(
        {"Open": float, "High": float, "Low": float, "Close": float}
    )


def run_a(**kw):
    args = dict(interval="5m", range_="1d", previous_close=99.0, symbol="TEST")
    args.update(kw)
    return journey.compute_journey(frame_a(), **args)


def test_headline_numbers():
    j = run_a()
    assert j["open"] == 100 and j["close"] == 105
    assert j["change"] == 5 and j["changePercent"] == 5.0
    # highest High = 106.5 on bar 8 (10:10), lowest Low = 94.5 on bar 5 (09:55)
    assert (j["high"]["price"], j["high"]["label"]) == (106.5, "10:10 EDT")
    assert (j["low"]["price"], j["low"]["label"]) == (94.5, "09:55 EDT")
    assert j["rangePercent"] == pytest.approx((106.5 - 94.5) / 94.5 * 100, abs=1e-4)  # 12.6984
    assert j["gapPercent"] == pytest.approx((100 - 99) / 99 * 100, abs=1e-4)  # 1.0101
    assert j["timezone"] == "America/New_York" and j["barCount"] == 10


def test_drawdown_and_run_up():
    j = run_a()
    dd = j["maxDrawdown"]
    # peak close 104 (bar 2, 09:40) -> trough 95 (bar 5, 09:55): (95-104)/104 = -8.6538 %
    assert dd["percent"] == pytest.approx(-9 / 104 * 100, abs=1e-4)
    assert (dd["start"]["price"], dd["start"]["label"]) == (104, "09:40 EDT")
    assert (dd["end"]["price"], dd["end"]["label"]) == (95, "09:55 EDT")
    # first later close >= 104 is bar 8 (106) at 10:10
    assert dd["recovered"] is True and dd["recoveredAt"]["label"] == "10:10 EDT"
    ru = j["maxRunUp"]
    # trough close 95 (bar 5) -> peak close 106 (bar 8): 11/95 = 11.5789 %
    assert ru["percent"] == pytest.approx(11 / 95 * 100, abs=1e-4)
    assert (ru["start"]["label"], ru["end"]["label"]) == ("09:55 EDT", "10:10 EDT")


def test_unrecovered_drawdown():
    df = frame_a()
    df.loc[df.index[8:], "Close"] = [100.0, 99.0]  # never gets back to 104
    j = journey.compute_journey(df, "5m", "1d", symbol="T")
    assert j["maxDrawdown"]["recovered"] is False and j["maxDrawdown"]["recoveredAt"] is None


def test_legs_follow_the_zigzag():
    j = run_a()
    # swing threshold = 25 % of the close range (106-95)/95 = 2.89 %  -> pivots at bars 0, 2, 5, 8
    got = [(L["direction"], round(L["percent"], 4), L["start"]["label"], L["end"]["label"]) for L in j["legs"]]
    assert got == [
        ("rise", 4.0, "09:30 EDT", "09:40 EDT"),
        ("fall", round(-9 / 104 * 100, 4), "09:40 EDT", "09:55 EDT"),
        ("rise", round(11 / 95 * 100, 4), "09:55 EDT", "10:10 EDT"),
    ]


def test_bar_statistics():
    j = run_a()
    assert j["bars"] == {"up": 5, "down": 3, "flat": 2}
    # biggest close-to-close rise: bar 7 (98 -> 103) = 5.102 %, fall: bar 4 (101 -> 97) = -3.9604 %
    assert j["biggestBar"]["up"]["percent"] == pytest.approx(5 / 98 * 100, abs=1e-4)
    assert j["biggestBar"]["up"]["label"] == "10:05 EDT"
    assert j["biggestBar"]["down"]["percent"] == pytest.approx(-4 / 101 * 100, abs=1e-4)
    assert j["biggestBar"]["down"]["label"] == "09:50 EDT"
    rets = [(C[i] - C[i - 1]) / C[i - 1] for i in range(1, 10)]
    assert j["volatility"]["perBarPercent"] == pytest.approx(statistics.stdev(rets) * 100, abs=1e-4)


def test_volume_and_vwap():
    j = run_a()
    assert j["volume"]["total"] == 1900 and j["volume"]["averagePerBar"] == 190
    # mean 190, sample std 284.6 -> cutoff 759: only bar 8 (1000 shares) qualifies, 1000/190 = 5.26x
    assert [(s["label"], s["volume"], s["multiple"]) for s in j["volume"]["spikes"]] == [("10:10 EDT", 1000, 5.26)]
    hi = [max(o, c) + 0.5 for o, c in zip(O, C)]
    lo = [min(o, c) - 0.5 for o, c in zip(O, C)]
    expected = sum((h + l + c) / 3 * v for h, l, c, v in zip(hi, lo, C, V)) / sum(V)
    assert j["vwap"] == pytest.approx(expected, abs=1e-3)


def test_timeline_is_chronological_and_readable():
    j = run_a()
    assert [e["kind"] for e in j["timeline"]] == ["open", "rise", "fall", "rise", "low", "high", "volume", "close"]
    texts = {e["kind"]: e["text"] for e in j["timeline"]}
    assert texts["open"] == "Opened at $100.00, up 1.01% from the previous close of $99.00."
    assert texts["high"] == "Day high of $106.50."
    assert texts["low"] == "Day low of $94.50."
    assert texts["close"] == "Closed at $105.00, +5.00% for the period."
    fall = next(e for e in j["timeline"] if e["kind"] == "fall")
    assert fall["text"] == "Fell 8.65% from $104.00 to $95.00, between 09:40 EDT and 09:55 EDT."
    assert fall["time"].startswith("2026-10-14T09:40") and fall["endTime"].startswith("2026-10-14T09:55")


def test_daily_bars_use_dates_and_no_gap():
    idx = pd.date_range("2026-10-01", periods=5, freq="D", tz="America/New_York")
    df = pd.DataFrame({"Open": [10.0, 12, 14, 16, 18], "High": [11.0, 13, 15, 17, 19],
                       "Low": [9.0, 11, 13, 15, 17], "Close": [10.0, 12, 14, 16, 18], "Volume": [5, 5, 5, 5, 5]}, index=idx)
    j = journey.compute_journey(df, "1d", "5d", previous_close=9.0, symbol="T")
    assert j["periodStart"]["label"] == "Oct 01, 2026" and j["periodEnd"]["label"] == "Oct 05, 2026"
    assert j["gapPercent"] is None            # gap is only defined for a single-day view
    assert j["maxDrawdown"] is None           # never fell
    assert j["maxRunUp"]["percent"] == pytest.approx(80.0)
    assert [(L["direction"], L["percent"]) for L in j["legs"]] == [("rise", 80.0)]
    assert j["volume"]["spikes"] == []        # fewer than 10 bars: no spike detection
    assert next(e for e in j["timeline"] if e["kind"] == "high")["text"] == "Period high of $19.00."


def test_single_bar_does_not_crash():
    df = frame_a().iloc[:1]
    j = journey.compute_journey(df, "5m", "1d", symbol="T")
    assert j["barCount"] == 1 and j["maxDrawdown"] is None and j["maxRunUp"] is None
    assert j["volatility"]["perBarPercent"] is None and j["legs"] == []
    assert [e["kind"] for e in j["timeline"]] == ["open", "high", "low", "close"]


def test_bad_rows_are_dropped_and_zero_volume_has_no_vwap():
    df = frame_a()
    df.loc[df.index[3], "Close"] = float("nan")
    df["Volume"] = 0
    j = journey.compute_journey(df, "5m", "1d", symbol="T")
    assert j["barCount"] == 9 and j["vwap"] is None and j["volume"]["total"] == 0
    with pytest.raises(ValueError):
        journey.compute_journey(df.iloc[0:0], "5m", "1d")


def test_output_is_valid_json_without_nan():
    json.dumps(run_a(), allow_nan=False)


# ---- API ------------------------------------------------------------------------------------------
class FakeTicker:
    calls = 0
    fail = False
    empty = False

    def __init__(self, symbol):
        self.symbol = symbol
        self.fast_info = {"currency": "USD", "year_high": 200.0, "year_low": 80.0}

    def history(self, period, interval):
        FakeTicker.calls += 1
        if FakeTicker.fail:
            raise RuntimeError("yahoo down")
        if FakeTicker.empty:
            return pd.DataFrame()
        if (period, interval) == ("5d", "1d"):
            return pd.DataFrame({"Close": [99.0, 104.0]}, index=pd.date_range("2026-10-13", periods=2, tz="UTC"))
        return frame_a()


@pytest.fixture()
def client(monkeypatch):
    from fastapi.testclient import TestClient
    import main

    monkeypatch.setattr(stocks, "yf", types.SimpleNamespace(Ticker=FakeTicker))
    stocks._cache.clear()
    FakeTicker.calls, FakeTicker.fail, FakeTicker.empty = 0, False, False
    return TestClient(main.app)


def test_api_journey_ok(client):
    r = client.get("/api/stocks/aapl/journey?range=1d")
    assert r.status_code == 200
    body = r.json()
    assert body["symbol"] == "AAPL" and body["range"] == "1d" and body["interval"] == "5m"
    assert body["gapPercent"] == pytest.approx(1.0101, abs=1e-4)  # previous close 99 from the daily fake
    assert body["yearHigh"] == 200.0 and body["yearLow"] == 80.0
    assert len(body["history"]) == 10 and body["storyMethod"] == "rule-based"


def test_api_missing_year_range_is_null(client, monkeypatch):
    monkeypatch.setattr(FakeTicker, "__init__", lambda self, s: setattr(self, "fast_info", {}))
    body = client.get("/api/stocks/AAPL/journey?range=5d").json()
    assert body["yearHigh"] is None and body["yearLow"] is None and body["currency"] == "USD"


def test_api_rejects_bad_input(client):
    assert client.get("/api/stocks/AAPL/journey?range=10y").status_code == 400
    assert client.get("/api/stocks/AAPL?range=1y&interval=5m").status_code == 400   # Yahoo would reject this pair
    assert client.get("/api/stocks/AAPL?range=1d&interval=1m").status_code == 400
    assert client.get("/api/stocks/bad%20sym!/journey").status_code == 400
    assert FakeTicker.calls == 0                                                      # nothing reached Yahoo


def test_api_not_found_and_provider_errors(client):
    FakeTicker.empty = True
    assert client.get("/api/stocks/NOPE/journey?range=1d").status_code == 404
    FakeTicker.empty, FakeTicker.fail = False, True
    r = client.get("/api/stocks/AAPL/journey?range=1mo")
    assert r.status_code == 502 and "yahoo" not in r.text.lower()


def test_cache_serves_repeat_requests_and_is_bounded(client):
    client.get("/api/stocks/AAPL/journey?range=1d")
    used = FakeTicker.calls
    client.get("/api/stocks/AAPL/journey?range=1d")
    assert FakeTicker.calls == used                      # second request came from the cache
    for i in range(stocks.CACHE_MAX_ENTRIES + 25):
        stocks._cache_put(("x", i), i)
    assert len(stocks._cache) <= stocks.CACHE_MAX_ENTRIES


def test_existing_quote_endpoint_still_works(client):
    r = client.get("/api/stocks/AAPL?range=1d&interval=5m")
    assert r.status_code == 200 and r.json()["symbol"] == "AAPL" and len(r.json()["history"]) == 10
