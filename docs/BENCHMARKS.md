# Benchmarks

Written by `./build.sh bench`. The numbers below are the engine benchmark's own output,
measured on the machine described here; they will differ on other machines.

## Machine

| | |
|---|---|
| Date (UTC) | 2026-11-03 21:57 |
| CPU | 12th Gen Intel(R) Core(TM) i5-12450H |
| Logical cores | 12 |
| Memory | 7.6 GiB |
| OS | Linux 6.18.54.1-microsoft-standard-WSL2 |
| Compiler | c++ (Ubuntu 15.2.0-16ubuntu1) 15.2.0 |
| Build type | Release |
| Source commit | 480be58 |

## Results

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
| lock-free | 1 | 2.14 | 70 | 2754 |
| mutex | 1 | 2.71 | 91 | 2537 |
| elastic ring | 1 | 14.99 | 29 | 101 |
| lock-free | 2 | 4.33 | 62 | 1448 |
| mutex | 2 | 5.98 | 40 | 2901 |
| elastic ring | 2 | 14.50 | 117 | 178 |
| lock-free | 4 | 3.36 | 531 | 4181 |
| mutex | 4 | 5.08 | 43 | 20451 |
| elastic ring | 4 | 20.88 | 135 | 250 |
| lock-free | 8 | 2.33 | 1334 | 34062 |
| mutex | 8 | 4.01 | 65 | 42328 |
| elastic ring | 8 | 19.61 | 222 | 1013 |

## Queue burst: consumer starts 20 ms late

4 producers, 250000 items each. Elastic rings are sized so the burst fits (2^21 slots), half fits (2^18), or barely fits at all (2^8).

| Queue | enqueue P50 (ns) | enqueue P99 (ns) | Drain (ms) | Items through overflow |
|---|---|---|---|---|
| lock-free list | 611 | 3925 | 275.5 | every item is a heap node |
| elastic ring 2^21 | 153 | 254 | 25.9 | 0 |
| elastic ring 2^18 | 170 | 541 | 76.2 | 612368 |
| elastic ring 2^8 | 208 | 690 | 120.6 | 999744 |

## Order book: std::map vs dense array

1000000 operations (about 10% cancels) on one symbol, prices within +-10 cents of a drifting mid price. One thread.

| Book | Throughput (M ops/s) | P50 (ns) | P99 (ns) | Trades |
|---|---|---|---|---|
| MapBook (std::map) | 11.09 | 109 | 372 | 822471 |
| DenseBook (array) | 15.56 | 86 | 355 | 822471 |

## WAL append: write() vs io_uring

200000 frames per run, 5 runs each, taking turns, one thread, no fsync. One frame per system call and the call waits for the result, because the engine must not acknowledge an order before its frame is written. Per-call time includes about 20-30 ns for reading the clock.

| Backend | P50 (ns) | P99 (ns) | P99.9 (ns) | Frames/s |
|---|---|---|---|---|
| write() | 547 | 1887 | 5979 | 910981 |
| io_uring | 37387 | 72619 | 294849 | 25396 |

## Whole server, by engine flag

Measured over TCP by `engine/bench/server_bench.cpp`. RTT is send to ack. The matcher columns are
the server's own numbers, from queue push to matching finished; they show a backlog when the load is
more than the matching thread can take.

### Core pinning

4 connections, 30000 orders per run, 30 runs per configuration, paced at 2000 orders/s in total. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| unpinned | 2000 | 2000 to 2000 | 139.0 | 476.5 | 949.4 | 47.1 | 292.0 | 137 to 4639 |
| pinned | 2000 | 2000 to 2000 | 137.3 | 473.7 | 928.2 | 44.8 | 297.9 | 133 to 362 |

4 connections, 200000 orders per run, 7 runs per configuration, closed loop, as fast as possible. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| unpinned | 17660 | 17348 to 18013 | 197.3 | 841.6 | 1261.7 | 2097444.4 | 3384447.6 | 3252334 to 3476943 |
| pinned | 17532 | 16812 to 18039 | 201.8 | 854.6 | 1289.5 | 2075571.1 | 3237336.2 | 3076431 to 3384317 |

### WAL writes

4 connections, 30000 orders per run, 9 runs per configuration, paced at 2000 orders/s in total. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| write() | 2000 | 2000 to 2000 | 134.3 | 452.5 | 865.9 | 50.6 | 315.9 | 129 to 384 |
| io_uring | 2000 | 2000 to 2000 | 273.2 | 776.0 | 1411.4 | 43.5 | 203.2 | 186 to 264 |

4 connections, 200000 orders per run, 5 runs per configuration, closed loop, as fast as possible. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| write() | 17870 | 17627 to 18205 | 196.0 | 830.7 | 1256.8 | 2058142.1 | 3303535.1 | 3229404 to 3506630 |
| io_uring | 9966 | 9849 to 10178 | 94.3 | 3066.1 | 5132.0 | 22.5 | 561.9 | 506 to 741 |

### Replication

4 connections, 30000 orders per run, 9 runs per configuration, paced at 2000 orders/s in total. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| no replication | 2000 | 2000 to 2000 | 124.1 | 447.0 | 948.0 | 50.0 | 301.1 | 127 to 427 |
| --replicate, no follower | 2000 | 2000 to 2000 | 150.2 | 468.9 | 957.8 | 46.7 | 303.2 | 240 to 341 |
| with a follower | 2000 | 1995 to 2000 | 163.9 | 493.7 | 1029.8 | 46.2 | 262.7 | 146 to 301 |

with a follower: the follower had every order 1 ms after the last ack (median; includes waiting for its own matcher to finish).

4 connections, 200000 orders per run, 5 runs per configuration, closed loop, as fast as possible. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| no replication | 16082 | 14933 to 17181 | 215.9 | 957.3 | 1488.8 | 2195070.9 | 3371839.2 | 2760406 to 3473665 |
| with a follower | 11720 | 10865 to 11865 | 297.9 | 1277.0 | 1913.4 | 1279.7 | 9771.8 | 5354 to 12121 |

with a follower: the follower had every order 1 ms after the last ack (median; includes waiting for its own matcher to finish).

### Queue

4 connections, 30000 orders per run, 9 runs per configuration, paced at 2000 orders/s in total. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| lock-free list | 2000 | 2000 to 2000 | 133.7 | 445.6 | 837.6 | 48.5 | 297.0 | 113 to 314 |
| elastic ring | 2000 | 2000 to 2000 | 136.7 | 430.4 | 807.6 | 48.4 | 307.0 | 247 to 326 |

4 connections, 200000 orders per run, 5 runs per configuration, closed loop, as fast as possible. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| lock-free list | 17554 | 17145 to 17984 | 199.8 | 854.1 | 1289.8 | 2125259.1 | 3394576.1 | 3115013 to 3510475 |
| elastic ring | 17482 | 17163 to 17913 | 203.7 | 838.6 | 1271.2 | 2069785.6 | 3353264.4 | 3154346 to 3479764 |

### SSTable and compaction writes: normal path vs io_uring

Median of 11 runs. Writing includes fsync and rename. One thread, nothing else running. O_DIRECT on this file system: used.

| Operation | Normal write (ms) | io_uring (ms) |
|---|---|---|
| Write 10,000 trades | 6.9 | 8.1 |
| Write 1,000,000 trades | 170.2 | 200.1 |
| Compact 7 tables, 14,000 trades | 12.6 | 13.8 |


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

## TickForge database vs MySQL

Written by `./build.sh bench-mysql` (`bench/mysql_baseline/`). This compares a narrow job, storing fixed-schema trade records. It says nothing about general database quality: MySQL also provides SQL, secondary indexes, multi-row transactions, replication tooling and backups, and TickForge's database provides none of those.

| | |
|---|---|
| Date (UTC) | 2026-11-03 19:34 |
| MySQL | Ver 8.4.11-0ubuntu0.26.04.1, from the Ubuntu packages, InnoDB |
| MySQL settings, all runs | `--innodb-buffer-pool-size=1G --innodb-redo-log-capacity=1G --skip-networking --mysqlx=OFF --performance-schema=OFF --secure-file-priv=NULL`, everything else default |
| Client | One Rust thread. MySQL over a Unix socket (`mysql` crate); TickForge called in-process |
| Disk | ext4 on the WSL2 virtual disk, `.run/`, same disk for both systems |
| Kernel | 6.18.54.1-microsoft-standard-WSL2 |
| Workload | 200,000 trades one per commit (5,000 for fsync MySQL), and 200,000 trades in commits of 100; same generator, 9 columns, primary key on `trade_id` |
| Repeats | 3 runs, median shown |

Latency is per commit: `insert_trade` returning, or `COMMIT` returning. TickForge has no multi-insert, so its "commit of 100" is 100 single inserts, each written to its log. MySQL commits are autocommit `INSERT`s, one socket round trip each. CPU includes mysqld and the client. Bytes are what the disk received (`/proc/diskstats`, file system journal included) until dirty pages, the memtable and the page cache were written out, on an otherwise idle machine.

**Compare like with like.** TickForge's database acknowledges before an fsync, so the fair MySQL rows are the two with `flush=2`. The `flush=1` row is stronger than anything TickForge offers and is shown for reference only. fsync speed on a WSL2 virtual disk is not representative of a real NVMe drive.

| System | A commit means | Trades per commit | Trades/s | P50 (us) | P99 (us) | P99.99 (us) | CPU per trade (us) | Bytes written per trade |
|---|---|---|---|---|---|---|---|---|
| TickForge database (LSM) | page cache: survives a process crash, not a power cut | 1 | 291,675 | 1.1 | 3.9 | 7,451.4 | 2.5 | 130 |
| TickForge database (LSM) | page cache: survives a process crash, not a power cut | 100 | 349,098 | 105.7 | 6,938.0 | 76,445.2 | 2.2 | 130 |
| MySQL, no binlog, flush=2 | page cache: survives a process crash, not a power cut | 1 | 3,990 | 185.1 | 952.2 | 17,186.0 | 240.3 | 736 |
| MySQL, no binlog, flush=2 | page cache: survives a process crash, not a power cut | 100 | 51,692 | 1,023.2 | 10,512.4 | 86,304.8 | 13.8 | 537 |
| MySQL, binlog, flush=2, sync_binlog=0 | page cache: survives a process crash, not a power cut | 1 | 5,312 | 163.9 | 435.4 | 6,725.4 | 182.0 | 1,216 |
| MySQL, binlog, flush=2, sync_binlog=0 | page cache: survives a process crash, not a power cut | 100 | 83,584 | 894.4 | 7,200.3 | 37,615.4 | 11.0 | 612 |
| MySQL, binlog, flush=1, sync_binlog=1 | fsync: also survives a power cut (stronger than TickForge) | 1 | 142 | 6,728.9 | 12,339.1 | 22,960.8 | 1594.0 | 39,397 |
| MySQL, binlog, flush=1, sync_binlog=1 | fsync: also survives a power cut (stronger than TickForge) | 100 | 8,475 | 11,404.2 | 19,844.6 | 55,481.6 | 38.3 | 1,182 |

### Recovery after kill -9, 99,999 trades stored

Time from process start to "ready", and every trade verified present afterwards. The database's open reads all its SSTables and replays 9,999 trades from its log; MySQL's clean restart shows how much of its time is normal startup. The database has no clean shutdown, so it always takes the same path.

| System | After kill -9 (s) | After clean stop (s) |
|---|---|---|
| TickForge database (LSM) | 0.04 | same path |
| MySQL, no binlog, flush=2 | 3.31 | 1.02 |
| MySQL, binlog, flush=2, sync_binlog=0 | 3.60 | 0.90 |
| MySQL, binlog, flush=1, sync_binlog=1 | 2.18 | 1.13 |

MyRocks, which the project document suggests as the closest baseline, is not in the Ubuntu packages and was not run.
