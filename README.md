# TickForge

TickForge is a university systems project: a small stock exchange built to study what happens on the critical path of order matching.

- A **C++ matching engine** takes orders from several producer threads through a lock-free queue, matches them on one thread with price-time priority, and writes every accepted order to a write-ahead log (WAL) before acknowledging it.
- A **Rust database** (`tickforge_db`, an LSM tree written from scratch) stores every trade and is used from Python.
- A **Python service** (`exchange-api`) connects the pieces, runs 24 virtual traders with paper money, and streams live numbers to the browser.
- A second Python service (`market-data`) serves real stock prices from Yahoo Finance.
- A **React dashboard** shows the engine live, real market data, a per-stock "Journey", and a research section called *How'z that!*.

## Quick start

You need Python 3.10+, Node 20+, CMake 3.20+, a C++17 compiler, Rust (cargo) and curl. On Windows use WSL2.

```bash
./build.sh
```

That checks your tools (and prints the install command for anything missing), builds everything, starts the stack, and prints the URLs. Open **http://localhost:8443**. Press Ctrl+C to stop all of it. Running it twice is safe; the second run skips whatever has not changed.

| Command | What it does |
|---|---|
| `./build.sh` | build and run the whole stack |
| `./build.sh test` | C++ tests, Rust tests, pytest for both services, frontend typecheck and tests |
| `./build.sh bench` | run the benchmarks and write `docs/BENCHMARKS.md` |
| `./build.sh bench-mysql` | TickForge database vs MySQL; writes `docs/benchmarks/mysql.md` |
| `./build.sh kill9 [engine flags]` | crash check: send orders, `kill -9` the engine, restart it, compare state hashes |
| `./build.sh clean` | delete build output, `.venv`, `node_modules` and runtime data (`.run/`) |

Logs are in `.run/logs/`, data in `.run/data/`. Nothing is installed outside this folder, and the script never uses `sudo`.

## How it fits together

```
Browser :8443 ──┬── exchange-api :8001 ── TCP 127.0.0.1:9100 (JSON lines) ── engine
                │        │                                                   queue -> matcher -> book -> WAL
                │        └── tickforge_db (Rust, imported by Python)
                └── market-data :8000 ── Yahoo Finance (cached)
```

Prices are integer cents everywhere except the screen. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the walk-through and [docs/CONTRACTS.md](docs/CONTRACTS.md) for the exact messages, file formats and API.

## Status

"Verified" means a test or command in this repository checked it. Numbers (latency, throughput) are not quoted here until `./build.sh bench` has produced them; see [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

| Part | Status | Evidence |
|---|---|---|
| exchange-api: real buyer and seller per fill, integer-cent cash and P&L, live book, trade persistence, reconnect, REST and WebSockets | built, verified against a fake engine | `services/exchange-api/tests` (17 tests) |
| market-data: cached, timeouts on every Yahoo call, Journey analytics | built, verified (no network in tests) | `services/market-data/tests` (19 tests) |
| Frontend: dashboard with live engine data, order ticket, market data, Journey, *How'z that!* | built, verified | typecheck, `vite build`, 26 tests: telemetry parser, cent formatting, behavioural calculations, page smoke test |
| Behavioural features: daily vs long-term window, volatility-scaled axis, scenario preview before an order, return next to worst fall | built | calculations unit-tested; see below |
| `build.sh` | built, verified | `./build.sh test` passes all suites; the full stack was started with the real engine and database, and an order placed through the API matched in the engine, was attributed to the right two traders and appeared in the stored history |
| C++ engine: TCP server, price-time matching, cancel, risk checks, integer cents | built, verified | `ctest` (6 tests) incl. an end-to-end test over TCP |
| WAL and crash recovery | built, verified | `engine/tests/wal_recovery_test.cpp` (file cut at every byte, bit flips, writer killed with SIGKILL) and the engine test that `kill -9`s the server: the book hash is identical after restart. Survives a process crash, **not** a power cut (no fsync yet) |
| Lock-free queue | built, verified | stress test under ThreadSanitizer and AddressSanitizer; review notes in `docs/DECISIONS.md` |
| Dense-array order book (next to the `std::map` book) | built, verified, not used by the server | same random orders give identical trades and hash in `order_book_tests`; speed in `docs/BENCHMARKS.md` |
| Rust LSM database (`tickforge_db`): memtable, SSTable with Bloom filter, compaction | built, verified | `cargo test` and `storage/tests/test_python.py` |
| Engine benchmarks (lock-free vs mutex queue, dense vs map book) | built | `docs/BENCHMARKS.md`. On the test machine the mutex queue had higher raw throughput; read the table before drawing conclusions |
| Core pinning (on by default, `--no-pin` to disable, `--pin-core N` to choose) | built, verified | `engine/tests/pinning_test.cpp` reads each thread's allowed CPUs from `/proc`. Pinned vs unpinned in `docs/BENCHMARKS.md`: no regression, and the gain is inside the run-to-run spread on this WSL2 machine |
| MySQL baseline: the database vs MySQL 8.4 InnoDB, same trades | measured | `./build.sh bench-mysql`, results and settings in `docs/BENCHMARKS.md`. Faster at this one narrow job with the same durability; its P99.99 is no better, and MySQL with fsync is stronger than anything TickForge offers |
| Elastic dual ring queue (off by default, `--queue elastic`, `--ring-size N`) | built, verified, not the default | `engine/tests/elastic_ring_test.cpp` and the `kill -9` test on the real server, both under ThreadSanitizer and AddressSanitizer. Much faster than the list queue alone; no difference through the whole server, see `docs/BENCHMARKS.md` |
| io_uring for storage (off by default: `--wal-io uring` for the engine WAL, `TICKFORGE_DB_IO=uring` for SSTables and compaction) | built, verified, not the default | `engine/tests/uring_wal_test.cpp`, `storage/tests/uring_test.rs`: identical bytes, recovery, `kill -9`. Slower on this machine, see `docs/BENCHMARKS.md`, so the normal path stays |
| Leader to follower WAL shipping (off by default: `--replicate` on the leader, `--follow HOST:PORT` on the follower) | built, verified, on localhost | `engine/tests/replication_test.cpp`: real processes, both nodes end with the same state hash and a byte-identical WAL, `kill -9` on either node, also under ThreadSanitizer and AddressSanitizer. Asynchronous, and there is no automatic failover |
| Fsync or group commit for the WAL, per-table id index in the database | planned | |
| Journey "MAX" range (since listing) | planned: the dashboard code exists, the market-data side does not | |
| Dashboard progress against a benchmark index (feature 14, second half) | planned | |
| Kernel bypass networking (AF_XDP) | planned, not built | Feasibility only: the kernel supports it, but receiving packets needs root, which was not available here. See `docs/DECISIONS.md` |

### Behavioural features

These follow the research document. They use real Yahoo price history, not forecasts.

- **Evaluation window** (feature 11): the price panel switches between *Daily*, *30 days* and *1 year*.
- **Volatility-scaled axis** (feature 12): the chart's price axis spans what the stock normally does in that window; *Fit to data* is one click away.
- **Scenario preview** (feature 13): *Review order* shows what a position like this did over past holding periods (worst case, middle, best case, and how often it lost) before *Confirm and send*.
- **Return beside worst fall** (feature 14): the price panel and the order review show return and maximum drawdown together.

## Configuration

Defaults work out of the box. See [.env.example](frontend/.env.example) for the frontend addresses. `exchange-api` reads `TICKFORGE_ENGINE_HOST`, `TICKFORGE_ENGINE_PORT`, `TICKFORGE_DATA_DIR` and (tests only) `TICKFORGE_MEMORY_DB`. The database reads `TICKFORGE_DB_IO` (`standard` or `uring`). `./build.sh` passes `TICKFORGE_ENGINE_FLAGS` to the engine, for example `TICKFORGE_ENGINE_FLAGS=--no-pin ./build.sh`.

## Repository layout

```
build.sh                  build, test, benchmark, run
docs/                     ARCHITECTURE, CONTRACTS, DECISIONS, BENCHMARKS
engine/                   C++ matching engine, WAL, tests, benchmarks
storage/                  Rust database tickforge_db (PyO3 + maturin)
services/exchange-api/    FastAPI: engine client, traders, database, REST + WebSockets
services/market-data/     FastAPI: Yahoo prices, Journey analytics
frontend/                 React + Vite: src/features/<dashboard|market|exchange|journey|research|howzthat>, src/lib, src/components
```

The full project specification is in [TickForge_Full_Document.md](TickForge_Full_Document.md); the research pages live in `frontend/src/features/research/papers/` (see the README there).
