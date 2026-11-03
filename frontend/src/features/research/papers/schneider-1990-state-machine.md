---
title: Implementing Fault-Tolerant Services Using the State Machine Approach: A Tutorial
authors: Schneider, F. B.
year: 1990
venue: ACM Computing Surveys 22(4)
doi:
area: systems
status: implemented
reviewed: false
citationVerified: false
summary: Same inputs in the same order give the same state: the idea behind the engine's replay recovery.
seeAlso: oneil-1996-lsm-tree
order: 250
---

## Why it matters for TickForge
Our single matching thread is deterministic, so logging every input with a sequence number and replaying it after a crash rebuilds the exact book. This is built: every accepted input is written to the write-ahead log (CRC-32 frames) before it is acknowledged, and on restart the engine replays the log through the same matching code. `state_hash` (FNV-1a 64) lets a test prove the result.

Tests: `engine/tests/wal_recovery_test.cpp` (replay hash equality, file cut at every byte offset, bit-flip detection, writer killed with SIGKILL) and `engine/tests/engine_e2e_test.cpp` (the server is killed with `kill -9` and the hash after restart equals the hash before).

Limits: one `write()` per frame survives a killed process but not a power cut (no fsync or group commit yet, planned). There are no snapshots, so recovery replays the whole log. Recovery time is not measured.
