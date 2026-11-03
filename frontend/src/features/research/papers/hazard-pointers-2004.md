---
title: "Hazard Pointers: Safe Memory Reclamation for Lock-Free Objects"
authors: Michael, M. M.
year: 2004
venue: IEEE Transactions on Parallel and Distributed Systems 15(6)
doi: 10.1109/TPDS.2004.8
area: systems
status: implemented
reviewed: false
citationVerified: true
summary: How we free queue nodes without a garbage collector and without use-after-free.
seeAlso: michael-scott-1996
order: 20
---

## Research question
How can lock-free data structures free memory safely without garbage collection, reference counting or special hardware?

## Problem they solved
In a lock-free structure, one thread can remove a node while another thread is still about to read it.
Freeing the node immediately causes use-after-free; never freeing it leaks memory. Garbage collection or
reference counting add cost or are not available in C++.

## What they did
- Each thread owns a few **hazard pointer** slots. Before dereferencing a shared node, it writes the
  node's address into its slot, then re-checks that the node is still reachable.
- A thread that removes a node does not free it. It puts it on a private **retired list**.
- When the list reaches a threshold, the thread **scans** all hazard slots and frees only the retired
  nodes nobody has published.
- The number of retired-but-not-freed nodes stays bounded, and the scheme is lock-free.

## Findings
The author reports that hazard pointers bound the number of removed-but-not-yet-freed nodes, need only ordinary single-word reads and writes, and in his experiments performed as well as or better than the other memory-management methods compared. These results are the paper's, not TickForge's.

## What we took
- One hazard slot per producer thread, published before reading `tail`, then validated.
- A retired list and a threshold-triggered scan before any `delete`.

## What we changed or rejected
- **Only one thread retires.** Only the single consumer removes nodes, so the retired list is a plain
  vector owned by the consumer: no sharing, and it grows as needed instead of sitting in a fixed array
  (the first version used a fixed 1,024-slot array, which could overflow).
- **Only producers publish hazards.** The consumer is the only thread that frees nodes, so it never
  needs to protect itself from itself.
- **seq_cst ordering** on publishing and scanning. The publish (a store) must be visible before the
  re-check (a load); weaker orderings allow the two to be reordered.
- **Naive scan, in batches.** The paper suggests a hash set of hazard pointers so a scan costs O(R + H). We compare
  every retired node against every slot, O(R × H), but only once per 64 retirements. This is simple and
  small, but it is a known trade-off.

## Where in our code
`engine/include/lock_free_queue.hpp` — the hazard slots, the per-thread slot pool, the retired vector,
the scan that frees unprotected nodes, and the validation loop in `enqueue()`.

## How we verified it
- The queue stress test (see [[michael-scott-1996]]) under AddressSanitizer reports no use-after-free,
  and under ThreadSanitizer reports no data race. Both run as part of `ctest` (`./build.sh test`).
- A code audit of the queue found and fixed four issues (details in `docs/DECISIONS.md`):
  a possible use-after-free of the old head (the consumer now moves `tail` first), the memory ordering of
  the hazard publish and scan (now `seq_cst`), hazard slots shared once more than 64 threads had enqueued
  (now a pool of 128 slots that aborts when exceeded), and the fixed retire array (now a vector scanned in batches).
- Honest note: these were found by reading the code. The stress test passed on the old queue too, so we
  **did not manage to reproduce** the old bugs in a failing test.

## Result
No use-after-free or race found by the sanitizers in the stress test. Reclamation cost is not measured on
its own. The queue as a whole is slower than a mutex queue on raw throughput (`docs/BENCHMARKS.md`).

## Limits and trade-offs
- Sanitizers only find bugs on the interleavings that actually happen in a run; they are not a proof.
- The O(R × H) scan grows with the number of producer threads.
- At most 128 threads can use the queue at the same time; the 129th aborts with a message instead of
  corrupting memory. Slots go back to the pool when a thread ends.
