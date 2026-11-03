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
- `matching-engine/src/telemetry_main.cpp` — 18 buckets: bucket 0 is below 1 µs, bucket *i* covers
  2^(*i*−1) to 2^*i* µs, and the last bucket catches everything from 65,536 µs up. `percentile_us()` returns
  the upper bound of the bucket that contains the percentile.
- `frontend/src/App.tsx` — the Latency Histogram panel.

## How we verified it
Not verified by a test yet. There is no unit test for `percentile_us()`.

## Result
We do **not** quote latency numbers as results yet: they depend on the machine and the speed setting, and
there is no baseline to compare against.

## Limits and trade-offs
- A reported p99 of 64 µs means "between 32 and 64 µs".
- Anything at or above 65,536 µs is reported as 131,072 µs, so a one-second stall would show as about 131 ms.
- No p99.9 or p99.99 yet; those need far more samples and finer buckets.
- The measured latency is queue-to-match time on the matching thread; it includes time the matcher spends
  in `std::this_thread::yield()` when the queue is empty.
