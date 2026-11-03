# Contracts

Everything the parts of TickForge must agree on. If code and this file disagree, fix one of them in the same commit.

```
Browser :8443 ─┬─ exchange-api :8001 ── TCP 127.0.0.1:9100 (JSON lines) ── engine
               │        └── tickforge_db (Rust, imported by Python)
               └─ market-data :8000 ── Yahoo (cached)
```

## 1. Units

| Thing | Type | Notes |
|---|---|---|
| price | integer **cents** (`int64`) | `18950` = $189.50. Never a float anywhere. The UI formats dollars. |
| quantity | integer shares (`uint32`) | |
| time | integer **milliseconds** since Unix epoch | WAL, trades, database |
| side | string `"BUY"` or `"SELL"` | |
| symbol | engine: integer `symbol_id`; API and database: ticker string | `services/exchange-api/app/symbols.py` maps one to the other |

## 2. Engine TCP protocol

Server: `engine_server --port 9100 --wal <file>` listens on `127.0.0.1`. Each message is one JSON object on one line, ending in `\n`. Limit orders only (a "market" order is a limit order at the edge of the price band).

### In (client to engine)

```json
{"type":"new_order","client_ref":17,"symbol_id":3,"side":"BUY","price":18950,"qty":100}
{"type":"cancel","client_ref":18,"order_id":4021}
{"type":"command","name":"book","symbol_id":3,"depth":10}
{"type":"command","name":"stats"}
{"type":"command","name":"state_hash"}
```

`client_ref` is any integer the client chooses. The engine echoes it in the `ack` or `reject` so the client can match replies to requests.

### Out (engine to client)

| Message | Sent to | When |
|---|---|---|
| `ack` | the sender | the input was accepted **and is already in the WAL** |
| `reject` | the sender | the input failed validation or a risk check (not logged) |
| `trade` | every client | an order matched |
| `book` | the sender | reply to `command book` |
| `stats` | the sender | reply to `command stats` |
| `state_hash` | the sender | reply to `command state_hash` |

```json
{"type":"ack","client_ref":17,"order_id":4021,"seq":4021}
{"type":"reject","client_ref":17,"reason":"max_qty"}
{"type":"trade","trade_id":903,"seq":4022,"symbol_id":3,"price":18950,"qty":60,
 "buy_order_id":4021,"sell_order_id":3990,"taker_side":"BUY","ts_ms":1767225600123}
{"type":"book","symbol_id":3,"bids":[[18950,40],[18940,500]],"asks":[[18960,70]]}
{"type":"state_hash","hash":"9f3a1c0b5d2e7a44","last_seq":4022}
```

- `reason` is one of: `bad_request`, `unknown_symbol`, `max_qty`, `price_band`, `unknown_order`.
- `book` levels are `[price_cents, total_qty]`, best price first, aggregated per price.
- `order_id` of a new order equals the `seq` it was given. `trade_id` is a counter that starts at 1.
- A `cancel` that succeeds returns `ack` with the same `order_id`; the order is gone from the book.

### `stats` fields

```json
{"type":"stats","uptime_s":12.5,"submitted":4100,"processed":4100,"queue_depth":0,
 "orders_per_sec":812.0,"trades_total":903,"trades_per_sec":140.0,
 "avg_latency_us":9.2,"p50_latency_us":7.0,"p99_latency_us":41.0,
 "lat_hist":[0,12,340,...],"producers":[2100,2000],"threads":4,
 "cpu_pct":8.1,"rss_mb":14.2,"last_seq":4022,"state_hash":"9f3a1c0b5d2e7a44"}
```

- Latency is measured from "producer pushes onto the queue" to "matcher finished the order" (WAL write is not included; it happens before the push).
- `lat_hist` is 16 buckets by powers of two in microseconds (`<1, <2, <4, ... >=16384`).
- `producers` has one counter per connection (producer thread) seen so far.

### Risk checks (defaults, set by flags)

- `--max-qty 10000`: reject larger orders.
- `--band-pct 20`: once a symbol has traded, reject prices more than 20% away from the last trade price. Before the first trade there is no band.

### Rules

- Price-time priority. A trade prints at the **resting** order's price. Partial fills leave the remainder resting.
- One matching thread owns all books. Connection threads only parse, validate, write the WAL and push to the queue.
- Order of events: validate, assign `seq`, append to WAL, `ack`, push to queue, match, broadcast `trade`.

## 3. WAL file layout

One file, little-endian.

```
file   = header, frame*
header = "TFWAL001"                      8 bytes
frame  = len:u32  crc:u32  payload[len]
```

`crc` is CRC-32 (IEEE, polynomial 0xEDB88320, as in zlib) of `payload`.

| Payload | Layout |
|---|---|
| new order (`type=1`) | `u8 type, u64 seq, u64 ts_ms, u64 order_id, u32 symbol_id, u8 side (0=BUY,1=SELL), i64 price_cents, u32 qty` |
| cancel (`type=2`) | `u8 type, u64 seq, u64 ts_ms, u64 order_id` |

Recovery on start:

1. Read frames from the start. Stop at the first frame that is cut short or has a wrong CRC.
2. Truncate the file to the end of the last good frame (this drops a half-written last record).
3. Replay the good frames through the same matching code. Trades produced during replay are **not** re-sent to clients.
4. Continue numbering from `last_seq + 1`.

`state_hash()` is FNV-1a 64 over: `last_seq`, next trade id, then for each symbol in ascending id, each side in priority order, each resting order in FIFO order: `order_id, price, remaining_qty`. Printed as 16 lowercase hex digits. The same input sequence must always give the same hash.

## 4. Database (Python API)

Rust crate `tickforge_db` in `storage/`, built into the repo `.venv` with `maturin develop --release`.

```python
from tickforge_db import TickForgeDB

db = TickForgeDB("/path/to/dir")          # creates or reopens the directory
db.insert_trade(trade_id=903, symbol="AAPL", price_cents=18950, quantity=60,
                buy_order_id=4021, sell_order_id=3990,
                buyer_id=7, seller_id=12, timestamp_ms=1767225600123)  # -> None
db.get_trade(903)                         # -> dict or None
db.range(start_ms, end_ms, symbol=None)   # -> list[dict], start inclusive, end exclusive,
                                          #    sorted by (timestamp_ms, trade_id)
db.count()                                # -> int, distinct trade_ids
db.flush()                                # memtable -> new SSTable
db.compact()                              # merge SSTables (size-tiered); returns number merged
```

A returned dict has exactly these keys: `trade_id, symbol, price_cents, quantity, buy_order_id, sell_order_id, buyer_id, seller_id, timestamp_ms`.

Rules:

- When `insert_trade` returns, the trade survives a process crash (the database has its own small log that is replayed on open).
- Inserting an existing `trade_id` replaces it (so the API can safely re-send after a restart).
- `buyer_id` / `seller_id` are the virtual trader ids, 0 if unknown.
- Errors raise `OSError`; bad arguments raise `ValueError`.
- SSTable: sorted by `(timestamp_ms, trade_id)`, sparse index every 64 entries, Bloom filter on `trade_id`, CRC-32 footer. Files in the directory are named `sst-<n>.tfs`.

For tests only: `TICKFORGE_MEMORY_DB=1` makes the Python side use an in-memory stand-in with the same methods. Without it, a failed import of `tickforge_db` is a startup error.

## 5. exchange-api (port 8001)

Settings come from environment variables: `TICKFORGE_ENGINE_HOST` (127.0.0.1), `TICKFORGE_ENGINE_PORT` (9100), `TICKFORGE_DATA_DIR` (`.run/data`), `TICKFORGE_MEMORY_DB`.

REST (JSON, prices in cents):

| Route | Purpose |
|---|---|
| `GET /health` | `{"status":"ok","engine":"connected"\|"disconnected","trades":N}` |
| `POST /orders` | body `{trader_id, symbol, side, price, qty}` → `{order_id}` after the engine ack; 409 if rejected, with `reason` |
| `DELETE /orders/{order_id}` | cancel |
| `GET /orderbook?symbol=AAPL` | `{symbol, bids:[[price,qty]], asks:[[price,qty]]}` |
| `GET /trades?limit=100` | newest first |
| `GET /trades/history?start_ms=&end_ms=&symbol=` | from `tickforge_db.range` |
| `GET /traders`, `GET /traders/{id}` | cash (cents), holdings, realized P&L (cents), trade count |
| `GET /symbols` | the symbol list with ids |

A fill moves cash and shares between **the two traders who own the two orders**. The API keeps `order_id → trader_id` from the acks.

WebSockets: `/ws/trades`, `/ws/orderbook`, `/ws/traders` push the same JSON as the matching REST route whenever it changes.

### `/ws/telemetry`

Server to browser: two message types, exactly what `frontend/src/telemetry.ts` parses.

```json
{"type":"status","state":"running","error":""}
```
`state` is `closed` (engine not reachable), `running`, `paused` or `stopped`.

```json
{"type":"stats","uptime_s":12.5,"speed":1,"submitted":4100,"processed":4100,
 "queue_depth":0,"orders_per_sec":812.0,"trades_total":903,"trades_per_sec":140.0,
 "avg_latency_us":9.2,"p50_latency_us":7.0,"p99_latency_us":41.0,
 "cpu_pct":8.1,"rss_mb":14.2,"threads":4,"lat_hist":[...],"producers":[...],
 "book":{"bids":[[18950,40]],"asks":[[18960,70]]},
 "trades":[{"id":903,"price":18950,"qty":60,"buy":7,"sell":12}]}
```

All values come from the engine's `stats` reply, except `speed` (the API's trader-activity multiplier) and `trades` (new trades since the last message; `buy` / `sell` are trader ids). `price` values are cents; the UI formats dollars.

Browser to server:

```json
{"cmd":"start"}  {"cmd":"pause"}  {"cmd":"stop"}  {"cmd":"reset"}
{"cmd":"speed","value":10}
{"cmd":"order","side":"BUY","qty":100,"price":18950}
```

`start` / `pause` / `stop` control the virtual traders (the engine always runs). `reset` resets the virtual traders' cash and holdings; it does not touch the engine or stored trades. `speed` is 1, 10 or 100.

## 6. market-data (port 8000)

Unchanged routes (`/api/stocks...`, `/api/stocks/{symbol}/journey?range=`). Yahoo responses are cached in memory with a timeout on every request. Tests mock the provider and never use the network.

## 7. Ports and paths

| What | Value |
|---|---|
| frontend | 8443 |
| exchange-api | 8001 |
| market-data | 8000 |
| engine | 9100 (localhost only) |
| logs / data | `.run/logs/`, `.run/data/` |
| frontend env | `VITE_EXCHANGE_API_URL=http://127.0.0.1:8001`, `VITE_STOCK_API_URL=http://127.0.0.1:8000`, `VITE_TELEMETRY_URL=ws://127.0.0.1:8001/ws/telemetry` |
