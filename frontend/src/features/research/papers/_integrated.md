---
title: "TickForge: a measured, from-scratch mini exchange"
status: draft
---

## Abstract
TickForge is a small trading exchange built to study concurrency on the critical path of order matching.
Connection threads write each order to a write-ahead log, acknowledge it and hand it to a lock-free
multi-producer / single-consumer queue; one matching thread applies price-time priority on limit order books
and emits trades; every trade is stored in a Rust LSM-tree database; the engine's throughput, queue depth and
latency histogram are streamed to a web dashboard, which also shows real stock histories.
This draft describes what is built and how its correctness was checked. A first benchmark run is reported
below; it covers one machine and is not a general performance claim.

## Related work
{{related-work}}

## Design
- **Ingestion.** Connection threads parse and check an order, give it a sequence number, write it to the
  log, acknowledge it and enqueue it into an unbounded linked-list queue in the style of Michael and Scott,
  simplified for a single consumer.
- **Memory safety.** Nodes are freed with hazard pointers: producers publish the tail node they are about
  to read; only the consumer retires nodes, and it frees a node only after checking no hazard points at it.
- **Matching.** One thread owns the order books (one per symbol, prices in integer cents), so the books need
  no locks and results are repeatable for a given input order. Price-time priority; trades at the resting
  price; partial fills; cancel; a maximum quantity and a 20% price band as risk checks. The matcher sleeps
  on a condition variable when the queue is empty. A cache-aligned dense-array book sits next to the
  `std::map` book; the server uses the map book.
- **Recovery.** On restart the engine replays the log through the same matching code and rebuilds the exact
  book; a state hash proves it.
- **Storage.** exchange-api stores every trade in a Rust LSM-tree (memtable, SSTables with Bloom filter and
  sparse index, one size-tiered compaction).
- **Observation.** The engine reports its own statistics on request; exchange-api forwards them to the browser over a
  localhost-only WebSocket every second and checks every command sent back.
- **Planned.** fsync / group commit for the log, snapshots, compaction throttled by queue depth.

## Implementation
C++17 engine (`engine/`), Rust database (`storage/`), Python FastAPI market-data service using Yahoo Finance
(`services/market-data/`), Python exchange-api service (`services/exchange-api/`), React and TypeScript dashboard (`frontend/`).
Known simplifications: limit orders only (no market orders or modification); the log is not fsynced, so it
survives a killed process but not a power cut; the traders are 24 virtual accounts on paper money.

## Evaluation
What has been checked:
- Queue correctness: the stress test (nothing lost, nothing duplicated, per-producer order kept) passes as a
  normal build and under ThreadSanitizer and AddressSanitizer.
- Crash recovery: replay equals the live state, the log cut at every byte offset, bit flips detected, the
  writer killed with SIGKILL, and the whole server killed with `kill -9`: the state hash is the same after restart.
- Order books: the map book and the dense book give identical trades and state hash on the same random workload.
- Database: 28 Rust tests and 8 Python tests.
- Market-data analytics: tests with hand-calculated expected values.
- First benchmark (`docs/BENCHMARKS.md`, one machine, threads not pinned): the lock-free queue did not beat
  the mutex queue on raw throughput (1 producer 2.07 vs 2.85 M items/s; 8 producers 2.41 vs 3.66). Its
  enqueue P99 was lower at 4 producers (3920 vs 20564 ns) and 8 producers (26537 vs 45319 ns). The dense
  book ran 14.82 M ops/s (P50 84 ns, P99 347 ns) against 10.12 M ops/s (P50 114 ns, P99 402 ns) for the map book.

What has **not** been measured yet:
- Order-to-match latency beyond p99, and runs on other machines.
- WAL and matching latency during compaction, and the engine's own recovery time. (The database's recovery time, next to MySQL's, is in `docs/BENCHMARKS.md`.)
- Any user-facing effect of the behavioural features.

## Limitations
- Percentiles are upper bounds of power-of-two histogram buckets (16 buckets, the last one open-ended).
- The queue audit's bugs were found by reading the code; they were not reproduced in a failing test.
- The engine has only been built and tested on Linux (WSL2).
- Long-run stock histories use today's S&P 500, so they carry survivorship bias.

## References
{{references}}
