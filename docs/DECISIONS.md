# Decisions

Short notes on why things are the way they are. Newest at the bottom.

## Baseline (before the cleanup)

Checked on Ubuntu 26.04 (WSL2), cmake 4.2, g++ 15, rustc 1.99, Python 3.14, Node 22.

| Claim | What I found |
|---|---|
| `engine_server` target does not exist | Worse: `matching-engine/src/engine_server.cpp` was an **empty file**, and `CMakeLists.txt` also named `order_book_tests.cpp` and `btree_baseline.cpp`, which do not exist. `cmake` could not even configure. |
| Engine only prints random trades | True. `main.cpp` is a demo; prices are `double`; no server, cancel, snapshot or stats. |
| `telemetry-bridge/` missing | True. The README points at it. The dashboard can only show "simulation". |
| Two Rust crates | **Three**: a crate at the repo root (`src/`, `tests/`, `benches/`), `tickforge-db/` and `tickforge_db/`. The root crate and `tickforge_db` compile. `tickforge-db` fails on pyo3 0.21 with Python 3.14. |
| Nothing is persisted | True: the Python wrapper expected a class the module does not export, and silently used a list. |
| Committed junk | `matching-engine/build/`, `tickforge-db/target/`, `market-data/__pycache__/`, root `package-lock.json`, `exchange-api/data/wal.log`, `src/wal/new1111.cpp`: all removed. No `.vscode/` was tracked on this branch. |
| Ports disagree | Vite 8443, `start.sh` said 5173. Using 8443. |

Not re-checked individually (will be covered by the work that fixes them): random buyer/seller attribution in `exchange-api/main.py`, empty `_order_book`, Yahoo calls without cache or timeout, size of `App.tsx` (1,517 lines), `HowzThatPage.tsx` (907), `howzthat/content.ts` (939).

## Layout

`git mv` into `engine/`, `storage/`, `services/`. The three Rust crates are not merged yet: `storage/` holds the one that has the PyO3 binding; the other two sit in `storage/_to_merge/` until their SSTable reader, B-tree baseline and tests are folded in. That folder is deleted when the merge is done.

## Decisions

- **Prices are integer cents everywhere.** Floats cannot represent most prices exactly, and the recovery test compares hashes, so the state must be bit-exact.
- **One TCP connection, JSON lines.** Easy to debug with `nc`, no extra dependency. Throughput is limited by JSON parsing, which is fine here; the benchmarks measure the queue and book directly, not the socket.
- **Engine assigns `order_id` = `seq`.** One number to track, and replay reproduces it.
- **Rejected orders are not written to the WAL.** They change no state. Risk checks depend only on book state, so replay of accepted inputs gives the same result.
- **`start / pause / stop / reset / speed` control the virtual traders, not the engine.** The engine is a server that is always on.
- **Engine reports its own CPU and memory** from `/proc/self`, so the API does not need the engine's pid.
- **Linux and macOS only.** `build.sh` is bash; the sanitizer tests and `kill -9` recovery check need a Unix. On Windows use WSL2.
