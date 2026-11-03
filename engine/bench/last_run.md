# Benchmark run

- CPU: 12th Gen Intel(R) Core(TM) i5-12450H
- Logical cores: 12
- Compiler: 15.2.0
- Flags: -std=c++17 -O3 -DNDEBUG
- Threads are not pinned to cores.

## Queue: lock-free vs mutex

Items per producer: 200000. One consumer thread. Latency is the time inside `enqueue()`.

| Queue | Producers | Throughput (M items/s) | enqueue P50 (ns) | enqueue P99 (ns) |
|---|---|---|---|---|
| lock-free | 1 | 2.21 | 64 | 5738 |
| mutex | 1 | 3.16 | 44 | 1216 |
| lock-free | 2 | 4.15 | 60 | 1416 |
| mutex | 2 | 5.72 | 40 | 2615 |
| lock-free | 4 | 3.53 | 480 | 4995 |
| mutex | 4 | 4.59 | 53 | 22201 |
| lock-free | 8 | 2.25 | 1459 | 23460 |
| mutex | 8 | 3.08 | 87 | 49030 |

## Order book: std::map vs dense array

1000000 operations (about 10% cancels) on one symbol, prices within +-10 cents of a drifting mid price. One thread.

| Book | Throughput (M ops/s) | P50 (ns) | P99 (ns) | Trades |
|---|---|---|---|---|
| MapBook (std::map) | 10.11 | 116 | 427 | 822471 |
| DenseBook (array) | 13.39 | 82 | 303 | 822471 |

