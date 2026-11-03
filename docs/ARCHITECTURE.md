# Architecture

```
Browser :8443 ──┬── exchange-api :8001 ── TCP 127.0.0.1:9100 ── engine
                │        └── tickforge_db (Rust, in-process)
                └── market-data :8000 ── Yahoo Finance
```

The exact messages, file formats and API are in [CONTRACTS.md](CONTRACTS.md). This page explains how the parts work together.

## Engine (C++)

Connection threads parse and validate orders, write them to the write-ahead log, acknowledge them, and push them onto a lock-free queue. One matching thread owns every order book, applies price-time priority, and broadcasts trades. On restart the log is replayed through the same matching code, which rebuilds the same book (`state_hash` lets a test prove it).

Options, all described in [CONTRACTS.md](CONTRACTS.md) section 2: the matching thread is pinned to a core (`--no-pin` turns that off); `--queue elastic` replaces the linked-list queue with a ring plus overflow; `--wal-io uring` writes the WAL through io_uring; `--replicate` and `--follow` ship the WAL to a read-only follower. Only pinning is on by default. [DECISIONS.md](DECISIONS.md) and [BENCHMARKS.md](BENCHMARKS.md) say why.

## exchange-api (Python)

`app/main.py` holds the live state, `app/routes.py` the HTTP and WebSocket endpoints.

1. **Engine client** (`engine_client.py`): one TCP connection, reconnects when it drops. Each order is sent with a `client_ref`; the `ack` gives back the engine's `order_id`, and the client remembers `order_id -> trader`. That is how a `trade` message (which only names two order ids) becomes a fill for two real traders.
2. **Traders** (`traders.py`): 24 accounts in integer cents. A fill moves `price * qty` cents and `qty` shares between the buyer and the seller, and updates realized profit (average-cost method). Cash and shares are conserved exactly; a test checks it.
3. **Persistence** (`db.py`): every trade is written to `tickforge_db` on a single database thread. Without the module the service refuses to start (the in-memory stand-in exists only for tests).
4. **Order books**: read from the engine's `book` reply, never reconstructed from trades.
5. **Telemetry** (`/ws/telemetry`): once a second the engine's `stats` reply, plus the book and new trades, is pushed to the browser. Browser commands (`start`, `pause`, `stop`, `reset`, `speed`, `order`) control the virtual traders or place an order; the engine itself is always on.

The virtual traders send small random orders around the last trade price, so the numbers on the dashboard are real engine output for a simulated crowd. Start prices are made-up reference prices.

## market-data (Python)

Fetches history from Yahoo Finance through a small provider interface (tests replace it with a fake, so they never touch the network), caches answers for 30 seconds, and puts a 10 second timeout on every Yahoo call. `journey.py` turns price bars into the Journey summary (highs and lows, biggest fall and rise, swings, volume spikes, VWAP) with plain arithmetic that the tests check by hand.

## Frontend (React, TypeScript, Vite)

```
src/lib/          format (cents to dollars), telemetry parser and hook, API clients, behaviour calculations
src/components/   shared pieces: Panel, Badge, Segmented, Notice, Icon, Prose
src/features/     dashboard, market, exchange, journey, research (papers), howzthat (the research page)
```

Prices arrive as integer cents and are turned into dollars only when drawn. When a service is not reachable, panels show an empty state that says what to start; nothing is filled in with made-up numbers. The one place simulated data is shown (the virtual traders) is labelled as paper money.

The design tokens (colour, type, radius) are CSS variables in `src/index.css`; light and dark themes redefine the same names.

## Where the data lives

| What | Where |
|---|---|
| Orders accepted by the engine | the engine's WAL (`.run/data/engine.wal`) |
| Every trade | `tickforge_db` (`.run/data/trades-db/`) |
| Trader cash and holdings | memory in exchange-api; `reset` restores the starting values |
| Prices from Yahoo | memory cache in market-data (30 s) |
