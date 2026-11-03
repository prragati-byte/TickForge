---
title: "TickForge: a measured, from-scratch mini exchange"
status: draft
---

## Abstract
TickForge is a small trading exchange built to study concurrency on the critical path of order matching.
Producer threads submit orders through a lock-free multi-producer / single-consumer queue; one matching
thread applies price-time priority on a limit order book and emits trades; a telemetry driver streams
throughput, queue depth and a latency histogram to a web dashboard, which also shows real stock histories.
This draft describes what is built and how its correctness was checked. Performance against a baseline has
**not been measured yet**, so it makes no performance claims.

## Related work
{{related-work}}

## Design
- **Ingestion.** Producers call `MatchingEngine::submit()`, which enqueues into an unbounded linked-list
  queue in the style of Michael and Scott, simplified for a single consumer.
- **Memory safety.** Nodes are freed with hazard pointers: producers publish the tail node they are about
  to read; only the consumer retires nodes, and it frees a node only after checking no hazard points at it.
- **Matching.** One thread owns the order book, so the book itself needs no locks and results are
  repeatable for a given input order. Price-time priority; trades at the resting price.
- **Observation.** The engine reports its own statistics on request; exchange-api forwards them to the browser over a
  localhost-only WebSocket every second and checks every command sent back.
- **Planned.** Write-ahead log, LSM-tree storage, Bloom filters, compaction, crash recovery by replay.

## Implementation
C++17 engine (`engine/`), Python FastAPI market-data service using Yahoo Finance
(`services/market-data/`), Python exchange-api service (`services/exchange-api/`), React and TypeScript dashboard (`frontend/`).
Known simplifications: prices are `double` rather than integer ticks; one book for all symbols; no market
orders, cancels or modifications; the matcher spins and yields when idle, so CPU usage looks high.

## Evaluation
What has been checked:
- Queue correctness: 8 producers, 1 consumer, 1.6 million messages; nothing lost, nothing duplicated,
  per-producer order kept. Also passes under ThreadSanitizer and AddressSanitizer (800,000 messages).
- Market-data analytics: tests with hand-calculated expected values; deliberately broken versions of the
  code are caught by the tests (mutation testing).

What has **not** been measured yet:
- Throughput and latency against a mutex-based queue (the benchmark file exists but is empty).
- Tail latency beyond p99 (p99.9, p99.99).
- Any user-facing effect of the behavioural features.

## Limitations
- Percentiles are upper bounds of power-of-two histogram buckets, and the top bucket is open-ended
  (everything from 65 ms up is reported as 131 ms).
- The old queue reclamation bug was fixed by reasoning; it was not reproduced in a test.
- The engine has only been built and tested on Linux.
- Long-run stock histories use today's S&P 500, so they carry survivorship bias.

## References
{{references}}
