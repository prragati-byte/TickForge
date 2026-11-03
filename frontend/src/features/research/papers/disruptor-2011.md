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
A pre-allocated ring buffer avoids the per-message heap allocation our linked-list queue does today, and pads counters onto separate cache lines. A candidate for the elastic ingestion and object-pool work. Not built yet.
