## First run, kept for reference

The research pages quote these numbers. They are the first benchmark, before any of the optional features, and will not change when `./build.sh bench` runs again.

| | |
|---|---|
| Date (UTC) | 2026-11-03 09:57 |
| CPU | 12th Gen Intel(R) Core(TM) i5-12450H |
| Logical cores | 12 |
| Memory | 7.6 GiB |
| OS | Linux 6.18.54.1-microsoft-standard-WSL2 |
| Compiler | c++ (Ubuntu 15.2.0-16ubuntu1) 15.2.0 |
| Build type | Release |
| Source commit | 6b163a6 |

### Queue: lock-free vs mutex

Items per producer: 200000. One consumer thread. Latency is the time inside `enqueue()`.

| Queue | Producers | Throughput (M items/s) | enqueue P50 (ns) | enqueue P99 (ns) |
|---|---|---|---|---|
| lock-free | 1 | 2.07 | 87 | 6086 |
| mutex | 1 | 2.85 | 62 | 3000 |
| lock-free | 2 | 3.98 | 64 | 1692 |
| mutex | 2 | 5.70 | 40 | 2254 |
| lock-free | 4 | 3.70 | 432 | 3920 |
| mutex | 4 | 4.99 | 45 | 20564 |
| lock-free | 8 | 2.41 | 1289 | 26537 |
| mutex | 8 | 3.66 | 74 | 45319 |

### Order book: std::map vs dense array

1000000 operations (about 10% cancels) on one symbol, prices within +-10 cents of a drifting mid price. One thread.

| Book | Throughput (M ops/s) | P50 (ns) | P99 (ns) | Trades |
|---|---|---|---|---|
| MapBook (std::map) | 10.12 | 114 | 402 | 822471 |
| DenseBook (array) | 14.82 | 84 | 347 | 822471 |
