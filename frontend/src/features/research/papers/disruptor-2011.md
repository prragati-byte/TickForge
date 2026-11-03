---
title: Disruptor: High Performance Alternative to Bounded Queues for Exchanging Data Between Concurrent Threads
authors: Thompson, M., Farley, D., Barker, M., Gee, P. and Stewart, A.
year: 2011
venue: LMAX technical paper
doi:
area: systems
status: planned
reviewed: false
citationVerified: false
summary: Pre-allocated ring buffer; the alternative design to our linked-list queue.
seeAlso: michael-scott-1996
order: 240
---

## Why it matters for TickForge
A pre-allocated ring buffer avoids the per-message heap allocation our linked-list queue does today, and pads counters onto separate cache lines. In the first benchmark (`docs/BENCHMARKS.md`) the linked-list queue was slower than a mutex queue on raw throughput. A pre-allocated ring is now built as an option (`--queue elastic`, `engine/include/elastic_ring.hpp`): one ticket counter, a ring for normal flow and a heap list for bursts, with its counters on separate cache lines. Measured alone it is much faster than both, but through the whole server it makes no measurable difference, so the linked list stays the default. Object pools are not built.
