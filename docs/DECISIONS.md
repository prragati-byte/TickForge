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
- **Fills are attributed from the acks.** exchange-api remembers `order_id -> trader` from each `ack` and shrinks the remaining quantity on every trade. A manual order has trader id 0 and no account, so the other side of such a trade is the only one whose cash changes.
- **Resting orders do not reserve cash or shares.** Simpler than a reservation system; the order generator checks balances when it creates an order. A trader can end up slightly short; cash and shares are still conserved exactly across all traders.
- **Telemetry shows one symbol (AAPL).** The contract has one `book` in the stats message; the dashboard's order book panel uses `/ws/orderbook?symbol=` for any symbol.
- **The dashboard shows empty states, not sample data, when a service is down.** The old "simulation mode" mixed invented numbers with real ones.
- **Removed the wheel-scroll hijack** (`useSmoothScroll`). It broke keyboard and zoom use, and nothing depended on it.
- **Journey "MAX" is hidden.** The frontend code for it exists, but the market-data side was reverted before this cleanup and has no `max` range. Listed as planned.
- **Frontend colours go through role names** (`canvas`, `surface`, `line`, `fg`, `muted`, `accent`, `up`, `down`, `warn`) defined as CSS variables, so light and dark themes only redefine the variables.
- **Linux and macOS only.** `build.sh` is bash; the sanitizer tests and `kill -9` recovery check need a Unix. On Windows use WSL2.

## Engine (C++)

- **The old engine code was replaced, not patched.** The previous WAL wrote text lines and key/value records, the book used `double` prices, and nothing could run as a server. The new engine is `engine/include/*.hpp` plus `engine/src/engine_server.cpp` and `engine/src/wal.cpp`.
- **Ingress lock.** Connection threads take one mutex for "assign seq, write WAL frame, send ack, push to queue". That keeps queue order equal to seq order, which replay needs. The lock-free queue is still the hand-off to the matching thread; the lock is only held for one `write()` call.
- **WAL durability.** Each frame is one `write()` on an `O_APPEND` file. That survives a killed process (`kill -9`, tested) but not a power cut; there is no `fsync` per order because it would cap throughput at disk speed. Planned: group commit.
- **Price band is checked outside the matcher.** Connection threads read the last trade price of the symbol (an atomic). It can be one trade old. Replay does not repeat risk checks: an order in the WAL was accepted once and is applied as logged, so replay is exact.
- **Cancels are logged before we know they work.** The connection thread can only reject ids that were never issued. A cancel of an order that has since been filled is logged, then the matching thread answers `reject` with `unknown_order`. Replaying that cancel does nothing, so state stays exact. (CONTRACTS says rejected inputs are not logged; this is the one exception.)
- **`trade.seq` is the seq of the input that caused the trade** (the incoming order). Trade ids come from their own counter.
- **Valid symbol ids are 1 to 1000** (`MAX_SYMBOL_ID`). Anything else is `unknown_symbol`.
- **Two order books, one interface.** `MapBook` (std::map + deque) is the baseline and the one `engine_server` uses, because it accepts any price. `DenseBook` is an array with one 64-byte-aligned level per cent; it only accepts prices inside a fixed range, so it is used by the benchmark and by a test that feeds both books the same random orders and compares trades and state hash. Measured numbers are in `engine/bench/last_run.md`.
- **Latency numbers** are from "pushed onto the queue" to "matching finished" and exclude socket writes. p50/p99 come from the last 65,536 orders; `lat_hist` counts all orders since start.
- **Matching thread sleeps** on a condition variable when the queue is empty (10 ms timeout as a safety net); idle CPU measured at 0.2%.
- **Connection limit 100.** The queue supports 128 producer threads; extra connections are closed.

## Queue audit (`lock_free_queue.hpp`)

Found by reading the code. The old stress test passes on the old queue, so none of 1 to 3 is proven by a failing test; 4 and 5 are visible in the numbers.

1. **Possible use after free.** `dequeue()` freed the old head even if `tail_` still pointed to it (a producer had linked its node but not yet moved the tail). Another producer could then read the freed node. Fix: the consumer moves the tail first.
2. **Memory ordering.** A hazard pointer was published with `release` and checked with a later `acquire` load. Those can be reordered (store then load), so the free-scan might not see the hazard. Fix: `seq_cst` on publish, validation and scan.
3. **64-thread cap.** Slot numbers came from a counter that wrapped (`% 64`); two threads could share a hazard slot and overwrite each other. A server that makes one thread per connection reaches 64 quickly. Fix: slots come from a pool and are returned when a thread ends; limit raised to 128; the 129th concurrent thread aborts with a message instead of corrupting memory.
4. **Retire array of 1,024 slots.** When full, a node that was still hazardous was leaked, and `try_reclaim()` scanned 1,024 x 64 slots on every `dequeue()`. Fix: a consumer-only `std::vector` of retired nodes, scanned once per 64 retirements (no overflow, no leak).
5. **Cost.** Same stress test, same machine: old queue 153 / 177 / 196 ms (-O2), new queue 65 / 53 / 85 ms; under ThreadSanitizer the three cases took about 70 s with the old queue and about 1.5 s with the new one.

Both versions pass `queue_stress_test` under ThreadSanitizer and AddressSanitizer (15 runs each for the new one).

## Database (Rust)

- **One crate.** The three crates are merged into `storage/` (library name `tickforge_db`, `crate-type = ["cdylib", "rlib"]` under `[lib]`). Their code was rewritten around the contract: the JSON-lines SSTables, the `println!` triggers, the C++ WAL linked through `build.rs` and the half-finished PyO3 class are gone.
- **Matching code removed from Rust.** The root crate had its own order book and matcher (`exchange/`). The C++ engine owns matching, so a second implementation could only drift out of sync. Deleted.
- **B-tree baseline.** The memtable is a `BTreeMap` (a B-tree). The old "skip list" was also a `BTreeMap`, so it was renamed rather than faked. No separate B-tree file existed to keep.
- **SSTable reader kept in spirit, format replaced:** binary records sorted by `(timestamp_ms, trade_id)`, a sparse index entry every 64 records, a Bloom filter on `trade_id`, CRC-32 over the whole file in the footer. `open` refuses a file whose CRC does not match; a test flips every byte of a small file and checks each one is caught.
- **Python feature flag.** PyO3 is an optional dependency (`python` feature, turned on by `pyproject.toml`). Plain `cargo test` then needs no libpython. PyO3 is 0.30.1, the current release on crates.io (checked with `cargo search`); it builds and runs on Python 3.14.
- **The database has its own log** (`wal.log`, length + CRC frames). It is emptied after a flush. A crash between writing the SSTable and emptying the log only replays trades that are already in the table; ids are unique, so nothing doubles.
- **Compaction merges neighbours only.** Tables are ordered by file number and newer wins. Merging two tables with an older one in between could bring back an old copy of a replaced trade. `compact()` therefore takes the longest run of adjacent tables whose sizes are within 4x of each other, writes the result over the newest input's file number, then deletes the others. The memtable also flushes by itself at 10,000 trades, and a flush that leaves 8 or more tables triggers a compaction.
- **`get_trade` on an SSTable scans the data section** when the Bloom filter and the min/max id say "maybe", because the file is sorted by time, not by id. Misses (most lookups) never touch the disk. Planned: an id index per table.
- **`count()`** is kept as a number: computed once at open (one pass over all tables), then +1 for every insert of a new id.

## Core pinning

- **On by default, `--no-pin` to disable.** The rule for this work was that a feature stays off unless it shows no regression. It passed: over 15 paced runs, matcher P99 was 1234 us pinned and 1504 us unpinned, with a tighter spread; closed-loop throughput and RTT were equal or slightly better.
- **The gain is not established.** A shorter 5-run paced comparison went the other way (1470 us pinned, 766 us unpinned, ranges overlapping), and the matcher P99 spread between runs is larger than the difference. The honest reading is "no measured harm, no proven benefit on this machine". WSL2 pins to a virtual CPU, and Hyper-V still moves that between physical cores. A bare-metal run with `isolcpus` is what would test the hypothesis.
- **Why the last CPU.** The kernel keeps most interrupts and housekeeping on the low-numbered CPUs. `--pin-core` overrides it.
- **Only the matcher gets a core of its own.** Connection threads can be up to 100, so they share the remaining CPUs. They inherit that set from the main thread.
- **Pinning is not isolation.** Without `isolcpus` the kernel can still schedule other processes on that core.
- **Benchmark finding, separate from pinning.** At full closed-loop load (4 connections, about 15,000 orders/s) the matcher is the bottleneck: its P50 reaches about 2.4 s of queue backlog, because it sends each trade to every client from the matching thread. The RTT stays low because the ack is sent before matching. So `server_bench` has a paced mode, and the matcher columns only mean "latency" when the load is paced.

## MySQL baseline

- **Real MySQL, no root.** `run.py` unpacks the Ubuntu packages into `.run/mysql`, so nothing is installed on the system, as with the rest of `build.sh`. `TICKFORGE_MYSQLD` points it at another `mysqld`.
- **Separate crate.** `bench/mysql_baseline` has its own `Cargo.toml`, so `storage/` and `./build.sh test` never depend on a MySQL client.
- **Same durability is the only fair row.** Following section 11.6 of the project document: TickForge's database acknowledges before fsync, so it is compared with MySQL at `innodb_flush_log_at_trx_commit=2`. The `flush=1, sync_binlog=1` row is shown for reference, labelled as stronger. Commits there took about 7 ms on this virtual disk, so it uses 5,000 trades instead of 200,000.
- **Settings chosen in MySQL's favour.** Autocommit (one socket round trip per commit; the first version used `BEGIN` / `INSERT` / `COMMIT` and paid three), performance schema off, a Unix socket.
- **What the numbers say.** One trade per commit, about 55x MySQL's best fair row, most of that because a function call replaces a socket round trip. In batches of 100, about 4x. **P99.99 is not better:** 7 ms against 7 to 17 ms singly, 76 ms against 38 to 86 ms in batches, because flush and compaction run on the insert path. This is the cost the activity-aware compaction idea is meant to address.
- **Bytes written come from `/proc/diskstats`.** This WSL2 kernel has no `/proc/<pid>/io` (the first run reported 0 for everything, and those numbers were thrown away), so the count is the whole disk, which needs an idle machine.
- **Recovery test size.** 99,999 trades, one short of a memtable flush. The first attempt used 100,000, which left the log empty and made TickForge's recovery look better than its worst case.
- **Not explained.** MySQL without the binlog came out slower than with it, in both full runs (3,990 against 5,312 trades/s). The no-binlog configuration always ran first and the order was not varied, so this may be an artefact. Do not read it as a finding about MySQL.
- **P99.99 of the batch rows** comes from 2,000 commits, so it is close to the single worst commit.
- **MyRocks not run.** It is the closer LSM baseline according to the project document, but it is not in the Ubuntu packages.

## Elastic dual ring

- **One ticket counter instead of two modes.** The usual design has a "ring mode" and an "overflow mode", and the hard part is switching back without reordering. Here every enqueue takes a ticket with `fetch_add` and the consumer always takes tickets in order, wherever each item went. An item in overflow can never be overtaken, because the consumer does not move past its ticket. There is no switch.
- **Why order matters here.** The server needs queue order to be `seq` order, or replay gives a different state hash. `elastic_ring_test` feeds real orders through a ring of 2 and compares the state hash with direct matching.
- **Overflow is a Treiber stack of single nodes, not the segmented buffer in the project document.** The consumer takes the whole stack with `exchange` and files nodes by ticket in a private hash map. Nothing is popped singly, so there is no ABA problem and no hazard pointers. Segments would need memory reclamation on a path that only runs during a burst.
- **Off by default.** The queue alone is much faster (2.7x to 6.6x throughput, enqueue P99 8x to 129x lower, because normal flow allocates nothing). Through the whole server, the difference is inside the noise: `ingress_mu_` serialises the orders and the sockets take the time. So there is no regression, but no gain that would justify changing the default on the critical path, and it preallocates about 6 MB.
- **Testing the tests.** Five bugs were put into copies of the ring: relaxed ordering on publish, wrong overflow order, wrong slot sequence, a leaked node, overwriting a full slot. All five were caught (TSan, the order check, the order check, ASan, a hang). A broken ring can hang, so these tests have a timeout. Then 45 runs of the stress test (normal, TSan, ASan) and 15 rounds of the server tests under both sanitizers, no failures.
- **The server is now also tested under the sanitizers**, which it was not before: `engine_e2e_elastic_thread` and `_address` run the real `engine_server` with the crash test driving it, and fail if a sanitizer prints anything.
- **A known limit.** A producer stopped between taking its ticket and publishing holds up the consumer until it runs again. Nothing is lost. In the server, orders are enqueued under `ingress_mu_` anyway.

## io_uring for storage

- **Kernel support, checked first.** `CONFIG_IO_URING=y`, `kernel.io_uring_disabled=0`, and creating a ring works on this kernel (6.18, WSL2). Both code paths check by really creating a ring, because containers can block the system call on a kernel that has it. Asking for io_uring where it cannot work is a startup error, not a quiet fallback.
- **No liburing.** `liburing-dev` is not installed and `build.sh` does not install things, so the C++ side uses the system calls directly (`engine/src/uring.cpp`). The Rust side uses the `io-uring` crate, Linux only.
- **Two places, because storage means two things here.** The engine WAL, which the critical path waits on, and SSTable writes for flush and compaction, which is what the project document asks for ("io_uring with O_DIRECT compaction"). The database's own log still uses `write()`: it is small writes through a Python call, where io_uring has nothing to batch.
- **Measured slower, so off by default.** WAL append: 37 us against 0.5 us per frame, about 70x. Whole server at full load: 10,480 against 18,556 orders/s. RTT P50 at paced load: 260 against 118 us. SSTable and compaction writes: about 20% slower (193 against 161 ms for 1,000,000 trades).
- **Why the WAL is so slow.** An `iou-wrk` kernel thread was present in all 10 samples taken under load, with about 3 context switches per order. So the writes go through a kernel worker thread instead of finishing inside the system call. The likely reason is that a buffered append on ext4 cannot be done without blocking; that part was not checked further. The engine cannot batch to win this back, because an order must be logged before its ack and acks go out one at a time. A different file system or a group-commit design might change this; neither was tried.
- **One side effect worth noting.** With `--wal-io uring` at full load the matcher is no longer saturated (P50 22 us, against seconds of backlog), because the slower WAL holds the input rate below what the matcher can take. That is back-pressure from a slower log, not an improvement.
- **What was not measured.** O_DIRECT is meant to keep a large compaction from evicting the page cache and to make its I/O less disruptive to the rest of the machine. Time per file does not show that, and a benchmark under memory pressure was not done. So "slower" is the whole result here for now, not the last word on compaction.
- **Short writes and errors.** A short write continues where it stopped. A failed SSTable write stops new requests and waits for the ones in flight before returning, so the buffer is never freed while the kernel may read it. `EINVAL` from O_DIRECT (tmpfs, for example) repeats the write without it.

## Replication

- **WAL shipping, because the engine is already a replicated state machine in waiting.** Same inputs in the same order give the same state, which is what the crash recovery relies on. A follower runs the same matching code on the same frames.
- **The shipper reads the file, not a queue.** Each follower has a thread on the leader that reads the WAL file from its position and sends whole frames. A slow or absent follower costs the critical path nothing and needs no buffer: the backlog is the WAL. A new follower catches up the same way live ones are served.
- **Asynchronous.** Waiting for a follower before the ack would add a network round trip on the critical path. The price: an acknowledged order can be missing from the follower if the leader's disk is lost. Since neither node fsyncs, a power cut can lose data on both.
- **Same port, a new message type.** No second port to configure. `--replicate` is required, so a server without it answers `bad_request` exactly as before.
- **Followers refuse to run on a bad history.** The handshake compares the CRC of the follower's last frame with the leader's frame at that seq. A follower ahead of its leader, or with other data at that point, exits with code 3 rather than serve wrong numbers. This checks one frame, not the entire file.
- **No automatic failover, no chains.** Choosing a new leader safely needs a consensus protocol, which was not in scope. Promotion is manual: restart the follower without `--follow`; the test covers this. `--replicate` with `--follow` together is refused because it is not tested.
- **What the test proves.** Same state hash, same books and a byte-identical WAL, after: catch-up, live flow, 4 clients at once, `kill -9` of the follower under load, `kill -9` of the leader under load, and a restart. All of it also under TSan and ASan (10 runs each) and 20 plain runs, no failures.
- **Testing the test.** Six bugs were put into copies of the server. Three were caught at once: no WAL on the follower, dropped cancels, followers taking orders. Missing CRC check showed up as a hang (the timeout catches it). One is harmless: without the `follower_ahead` check, the next check refuses that follower as `diverged`. **One got through at first:** JSON lines mixed into the WAL stream, because the follower reconnects after a damaged frame and still ends up correct. So the follower now counts `damaged_frames` and the test requires 0; that catches it.
- **Cost, measured on one machine.** `--replicate` with no follower: none measurable. With a follower on the same machine: RTT P50 123 to 162 us at paced load; at full load 18,310 to 12,279 orders/s. The follower had everything about 1 ms after the last ack. This is why it is off by default. Localhost only: a real network was not tested.
