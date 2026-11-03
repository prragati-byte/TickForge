"""market-data service (port 8000): stock quotes and Journey data for the frontend."""
import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.stocks import (
    InvalidParameter,
    InvalidSymbol,
    StockNotFound,
    get_journey_data,
    get_stock_data,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("market-data")

app = FastAPI(title="TickForge market-data")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8443", "http://127.0.0.1:8443"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _run(fn, *args):
    try:
        return fn(*args)
    except InvalidSymbol:
        raise HTTPException(status_code=400, detail="Invalid symbol")
    except InvalidParameter as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except StockNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception:
        # Upstream (Yahoo) problem: log it, but do not leak internals to the browser.
        log.exception("provider error")
        raise HTTPException(status_code=502, detail="Market data provider unavailable")


@app.get("/hello")
def hello():
    return {"message": "stock API is running"}


@app.get("/api/stocks/{symbol}")
def get_stock(symbol: str, range: str = "1d", interval: str = "5m"):
    return _run(get_stock_data, symbol, range, interval)


@app.get("/api/stocks/{symbol}/journey")
def get_journey(symbol: str, range: str = "1d"):
    return _run(get_journey_data, symbol, range)
