---
title: The Tail at Scale
authors: Dean, J. and Barroso, L. A.
year: 2013
venue: Communications of the ACM 56(2), pp. 74–80
doi: 10.1145/2408776.2408794
area: systems
status: partial
reviewed: false
citationVerified: true
summary: Why we report latency percentiles instead of an average.
seeAlso: gould-2013-limit-order-books
order: 40
---

## Research question
Why do rare slow responses dominate the latency of large systems, and how can systems stay responsive despite them?

## Problem they solved
In large services, rare slow responses (the "tail") dominate what users feel, because one request fans
out to many servers and has to wait for the slowest one. Averages hide this.

## What they did
They explain where latency variability comes from (shared resources, background work, queueing, garbage
collection, power management) and propose ways to live with it, such as hedged and tied requests, rather
than trying to remove every source of delay.

## Findings
The authors illustrate how fan-out amplifies the tail: if a server is slow for 1 request in 100, a user request that must wait for 100 such servers is slow most of the time (about 63% in their example). They argue for tail-tolerant techniques rather than trying to remove every source of variability.

## What we took
Measure and show **percentiles** (p50, p99), not just an average, and show the whole distribution as a
histogram.

## What we changed or rejected
- Rejected their mitigation techniques (hedged and tied requests, micro-partitioning). TickForge is one
  process with no fan-out, so they do not apply.
- Our percentiles come from a power-of-two histogram, so they are **bucket upper bounds**, not exact values.

## Where in our code
- `engine/src/engine_server.cpp` — a 16-bucket histogram in microseconds (`<1, <2, <4, ... >=16384`),
  plus p50 and p99 over the last 65,536 orders. The time measured runs from "pushed onto the queue" to
  "matching finished" and leaves out socket writes. The engine sends them in its `stats` reply.
- `engine/bench/engine_bench.cpp` — measures the time inside `enqueue()` for a lock-free and a mutex
  queue, and the time per operation for the two order books, and reports P50 and P99.
- The Latency Histogram panel in the dashboard.

## How we verified it
There is no dedicated unit test for the engine's percentile code; the end-to-end test only checks that
the `stats` reply has its fields. The benchmark results are in `engine/bench/last_run.md`.

## Result
The first benchmark run (`docs/BENCHMARKS.md`, one machine, threads not pinned) reports enqueue P99 for
the lock-free queue against a mutex queue: 1692 vs 2254 ns at 2 producers, 3920 vs 20564 ns at 4, and
26537 vs 45319 ns at 8. The 2-producer difference is small and not reliable in this run. The lock-free
queue's P50 was higher at every producer count, and its raw throughput was lower, so the tail is the
only place it came out ahead.

## Limits and trade-offs
- The histogram buckets give upper bounds: a reported p99 of 64 µs means "between 32 and 64 µs".
- No p99.9 or p99.99 yet; those need far more samples and finer buckets.
- The benchmark is one machine and one run, so treat the numbers as a first look, not a conclusion.
