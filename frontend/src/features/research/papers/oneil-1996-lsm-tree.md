---
title: The Log-Structured Merge-Tree (LSM-Tree)
authors: O'Neil, P., Cheng, E., Gawlick, D. and O'Neil, E.
year: 1996
venue: Acta Informatica 33(4)
doi:
area: systems
status: partial
reviewed: false
citationVerified: false
summary: Foundation for the trade database (built); throttled compaction is still planned.
seeAlso: silk-2019, bloom-1970
order: 210
---

## Why it matters for TickForge
The trade store is an LSM-tree: an in-memory table that is flushed to sorted files on disk and merged. It is built as the Rust crate `storage/` (`tickforge_db`): a `BTreeMap` memtable (not a skip list) with its own log, binary SSTables with a sparse index, a Bloom filter and a CRC-32 footer, and one size-tiered compaction. Tests: `storage/tests/database_test.rs` and `storage/tests/test_python.py`.

Not built: an atomic MemTable swap, a per-table id index for `get_trade`, compaction throttled by queue depth, snapshots and Rust-side benchmarks. No result is quoted because nothing has been measured yet.
