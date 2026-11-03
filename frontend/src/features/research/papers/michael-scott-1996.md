---
title: Simple, Fast, and Practical Non-Blocking and Blocking Concurrent Queue Algorithms
authors: Michael, M. M. and Scott, M. L.
year: 1996
venue: Proc. 15th ACM Symposium on Principles of Distributed Computing (PODC), pp. 267–275
doi: 10.1145/248052.248106
url: https://www.cs.rochester.edu/u/scott/papers/1996_PODC_queues.pdf
area: systems
status: implemented
reviewed: false
citationVerified: true
summary: The lock-free linked-list queue our MPSC order queue is built on.
seeAlso: hazard-pointers-2004, disruptor-2011
order: 10
---

## Research question
How can many threads share a FIFO queue without a lock, simply enough to be practical?

## Problem they solved
Many threads need to share one FIFO queue. With a single lock, a thread that is delayed while holding
the lock (preempted, page fault) stalls every other thread, and contention on the lock grows with the
number of threads.

## What they did
- A singly linked list with a **dummy node**, so the queue is never truly empty and enqueue and dequeue
  touch different ends (`tail` and `head`).
- Enqueue links the new node with a compare-and-swap (CAS) on `tail->next`, then swings `tail` with a
  second CAS. If a thread finds `tail` lagging (its `next` is not null), it **helps** move `tail`
  forward instead of waiting. This is what makes the queue lock-free: some thread always makes progress.
- Counted pointers (a pointer plus a modification counter) to avoid the ABA problem.
- In the same paper, a **two-lock** blocking queue (one lock for head, one for tail) as the simple,
  fast blocking alternative.

## Findings
On a 12-processor SGI Challenge, the authors report that their non-blocking queue consistently outperformed the best alternatives they tested, and that their two-lock queue beat a single-lock queue when several processes competed for it. These are their measurements on their machine, not TickForge's.

## What we took
- The dummy node and the linked-list layout.
- CAS on `tail->next`, then CAS to swing `tail`.
- Tail helping: a producer that sees a lagging tail advances it.

## What we changed or rejected
- **Single consumer.** TickForge has exactly one matching thread, so `dequeue()` needs no CAS on
  `head`: only the consumer ever writes it, so a plain atomic store is enough.
- **Hazard pointers instead of counted pointers** to make freeing nodes safe (see [[hazard-pointers-2004]]).
- **The consumer helps the tail too.** Before moving `head` past a node, the consumer makes sure `tail`
  no longer points at it. Without this a retired node could still be reachable from `tail`, which breaks
  the hazard-pointer rule. This step is not in the original algorithm; it comes from combining it with
  hazard pointers and a single consumer.

## Where in our code
- `engine/include/lock_free_queue.hpp` — class `MPSCQueue`, functions `enqueue()` and `dequeue()`.
- Used by `engine/src/engine_server.cpp`: connection threads enqueue, the matching thread dequeues.

## How we verified it
- `engine/tests/queue_stress_test.cpp`: several producers and one consumer. Checks that nothing is lost,
  nothing is duplicated, and each producer's messages arrive in the order they were sent.
- It runs as part of `ctest` as a normal build, under ThreadSanitizer and under AddressSanitizer
  (all pass in `./build.sh test`).

## Result
Correctness: the stress test passes in all three builds.
Throughput against a mutex queue (`docs/BENCHMARKS.md`, one machine, threads not pinned, 200,000 items per
producer): the lock-free queue did **not** win. With 1 producer it ran 2.07 vs 2.85 M items/s, with 4
producers 3.70 vs 4.99, and with 8 producers 2.41 vs 3.66. Its enqueue P99 was lower at 4 producers
(3920 vs 20564 ns) and at 8 (26537 vs 45319 ns), but its P50 was higher. The paper's own two-lock queue
is not in the benchmark.

## Limits and trade-offs
- Every enqueue calls `new`: a heap allocation on the hot path (a pre-allocated pool is planned).
- Lock-free, not wait-free: under heavy contention a producer can retry its CAS many times. CAS retries
  are not counted yet.
- At most 128 threads at a time: hazard slots come from a pool and return to it when a thread ends. The
  129th thread aborts with a message instead of corrupting memory.
- Unbounded: a burst can grow memory without limit; there is no back-pressure.
