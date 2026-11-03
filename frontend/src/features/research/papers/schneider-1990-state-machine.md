---
title: Implementing Fault-Tolerant Services Using the State Machine Approach: A Tutorial
authors: Schneider, F. B.
year: 1990
venue: ACM Computing Surveys 22(4)
doi:
area: systems
status: planned
reviewed: false
citationVerified: false
summary: Same inputs in the same order give the same state: the idea behind planned replay recovery.
seeAlso: oneil-1996-lsm-tree
order: 250
---

## Why it matters for TickForge
Our single matching thread is deterministic, so logging every input with a sequence number and replaying it after a crash should rebuild the exact book. Planned, together with the write-ahead log. Not built yet.
