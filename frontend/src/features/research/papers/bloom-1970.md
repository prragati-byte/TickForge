---
title: Space/Time Trade-offs in Hash Coding with Allowable Errors
authors: Bloom, B. H.
year: 1970
venue: Communications of the ACM
doi:
area: systems
status: implemented
reviewed: false
citationVerified: false
summary: Bloom filters, used to skip disk files in trade_id lookups.
seeAlso: oneil-1996-lsm-tree
order: 220
---

## Why it matters for TickForge
Each sorted file (SSTable) in the LSM store carries a Bloom filter on `trade_id`, so a lookup can skip files that certainly do not hold the key (`storage/src/bloom.rs`, used by `storage/src/sstable.rs`). It is covered by the unit tests in those files and by `storage/tests/database_test.rs`.

Not measured: the false-positive rate and the lookup latency. A lookup still scans a table's data when the filter says "maybe", because the file is sorted by time, not by id; a per-table id index is planned.
