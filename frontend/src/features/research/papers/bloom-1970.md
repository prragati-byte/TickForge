---
title: Space/Time Trade-offs in Hash Coding with Allowable Errors
authors: Bloom, B. H.
year: 1970
venue: Communications of the ACM
doi:
area: systems
status: planned
reviewed: false
citationVerified: false
summary: Bloom filters, planned for skipping disk files in lookups.
seeAlso: oneil-1996-lsm-tree
order: 220
---

## Why it matters for TickForge
Each sorted file in the planned LSM store would carry a Bloom filter, so a lookup can skip files that certainly do not hold the key. Not built yet.
