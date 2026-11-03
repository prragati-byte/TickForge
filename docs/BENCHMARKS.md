# Benchmarks

Written by `./build.sh bench`. The numbers below are the engine benchmark's own output,
measured on the machine described here; they will differ on other machines.

## Machine

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
| lock-free | 1 | 2.07 | 87 | 6086 |
| mutex | 1 | 2.85 | 62 | 3000 |
| lock-free | 2 | 3.98 | 64 | 1692 |
| mutex | 2 | 5.70 | 40 | 2254 |
| lock-free | 4 | 3.70 | 432 | 3920 |
| mutex | 4 | 4.99 | 45 | 20564 |
| lock-free | 8 | 2.41 | 1289 | 26537 |
| mutex | 8 | 3.66 | 74 | 45319 |

## Order book: std::map vs dense array

1000000 operations (about 10% cancels) on one symbol, prices within +-10 cents of a drifting mid price. One thread.

| Book | Throughput (M ops/s) | P50 (ns) | P99 (ns) | Trades |
|---|---|---|---|---|
| MapBook (std::map) | 10.12 | 114 | 402 | 822471 |
| DenseBook (array) | 14.82 | 84 | 347 | 822471 |

## Whole server, by engine flag

Measured over TCP by `engine/bench/server_bench.cpp`. RTT is send to ack. The matcher columns are
the server's own numbers, from queue push to matching finished; they show a backlog when the load is
more than the matching thread can take.

### Core pinning

4 connections, 30000 orders per run, 15 runs per configuration, paced at 2000 orders/s in total. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| unpinned | 2000 | 1993 to 2000 | 183.8 | 1060.5 | 3667.1 | 58.5 | 1504.3 | 510 to 11118 |
| pinned | 2000 | 1999 to 2000 | 183.2 | 948.5 | 3311.8 | 52.5 | 1234.3 | 545 to 3877 |

4 connections, 200000 orders per run, 7 runs per configuration, closed loop, as fast as possible. Median over the runs; throughput also shows the slowest and fastest run. The matcher columns here are a backlog of seconds, not latency: this load is more than the matching thread can take.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) |
|---|---|---|---|---|---|---|---|
| unpinned | 15358 | 14654 to 15642 | 219.4 | 1009.9 | 1582.2 | 2381441.4 | 3930215.8 |
| pinned | 15711 | 14736 to 15978 | 214.2 | 986.9 | 1493.1 | 2330488.2 | 3849743.9 |

### Queue, whole server

4 connections, 30000 orders per run, 9 runs per configuration, paced at 2000 orders/s in total.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| lock-free list | 2000 | 2000 to 2000 | 122.6 | 396.6 | 857.3 | 43.4 | 290.1 | 112 to 339 |
| elastic ring | 2000 | 2000 to 2000 | 122.3 | 435.3 | 918.9 | 40.8 | 296.4 | 227 to 336 |

4 connections, 200000 orders per run, 5 runs per configuration, closed loop, as fast as possible.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| lock-free list | 18622 | 17479 to 18734 | 191.2 | 830.0 | 1272.7 | 2007207.7 | 3206254.1 | 2971686 to 3367006 |
| elastic ring | 18451 | 17747 to 19120 | 192.4 | 788.6 | 1210.1 | 2002849.7 | 3139007.0 | 2742227 to 3322015 |

### Queues alone, including the elastic ring

### Queue: lock-free vs mutex

Items per producer: 200000. One consumer thread. Latency is the time inside `enqueue()`.

| Queue | Producers | Throughput (M items/s) | enqueue P50 (ns) | enqueue P99 (ns) |
|---|---|---|---|---|
| lock-free | 1 | 2.02 | 72 | 12901 |
| mutex | 1 | 2.94 | 92 | 782 |
| elastic ring | 1 | 13.29 | 29 | 100 |
| lock-free | 2 | 4.05 | 60 | 1414 |
| mutex | 2 | 6.01 | 40 | 2665 |
| elastic ring | 2 | 15.30 | 110 | 170 |
| lock-free | 4 | 3.57 | 458 | 4082 |
| mutex | 4 | 5.15 | 42 | 20764 |
| elastic ring | 4 | 19.84 | 155 | 347 |
| lock-free | 8 | 2.54 | 1143 | 26950 |
| mutex | 8 | 4.27 | 65 | 39992 |
| elastic ring | 8 | 6.77 | 260 | 3132 |

### Queue burst: consumer starts 20 ms late

4 producers, 250000 items each. Elastic rings are sized so the burst fits (2^21 slots), half fits (2^18), or barely fits at all (2^8).

| Queue | enqueue P50 (ns) | enqueue P99 (ns) | Drain (ms) | Items through overflow |
|---|---|---|---|---|
| lock-free list | 601 | 3838 | 279.9 | every item is a heap node |
| elastic ring 2^21 | 145 | 255 | 29.4 | 0 |
| elastic ring 2^18 | 176 | 534 | 82.1 | 620704 |
| elastic ring 2^8 | 225 | 694 | 125.1 | 999744 |

### WAL append alone: write() vs io_uring

200000 frames per run, 5 runs each, taking turns, one thread, no fsync. One frame per system call and the call waits for the result, because the engine must not acknowledge an order before its frame is written. Per-call time includes about 20-30 ns for reading the clock.

| Backend | P50 (ns) | P99 (ns) | P99.9 (ns) | Frames/s |
|---|---|---|---|---|
| write() | 528 | 1863 | 4494 | 1370900 |
| io_uring | 37306 | 69137 | 276793 | 25638 |

### WAL writes, whole server

4 connections, 30000 orders per run, 9 runs per configuration, paced at 2000 orders/s in total. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| write() | 2000 | 2000 to 2000 | 118.4 | 377.3 | 798.3 | 42.7 | 267.2 | 176 to 290 |
| io_uring | 2000 | 2000 to 2000 | 259.8 | 699.9 | 1189.7 | 37.8 | 196.3 | 159 to 217 |

4 connections, 200000 orders per run, 5 runs per configuration, closed loop, as fast as possible. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| write() | 18556 | 16145 to 18851 | 187.5 | 799.0 | 1230.5 | 2017748.0 | 3284530.2 | 3096572 to 4294967 |
| io_uring | 10480 | 10151 to 10596 | 89.5 | 3027.3 | 5090.1 | 21.7 | 501.3 | 462 to 593 |

### SSTable and compaction writes: normal path vs io_uring

Median of 11 runs. Writing includes fsync and rename. One thread, nothing else running. O_DIRECT on this file system: used.

| Operation | Normal write (ms) | io_uring (ms) |
|---|---|---|
| Write 10,000 trades | 6.6 | 8.0 |
| Write 1,000,000 trades | 160.8 | 193.2 |
| Compact 7 tables, 14,000 trades | 13.2 | 15.4 |

### Replication

4 connections, 30000 orders per run, 9 runs per configuration, paced at 2000 orders/s in total. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| no replication | 2000 | 2000 to 2000 | 122.5 | 403.0 | 935.5 | 41.3 | 280.2 | 84 to 327 |
| --replicate, no follower | 2000 | 2000 to 2000 | 122.5 | 423.0 | 895.7 | 44.3 | 295.7 | 160 to 350 |
| with a follower | 2000 | 1996 to 2000 | 161.6 | 488.0 | 1121.5 | 41.5 | 298.8 | 185 to 1506 |

with a follower: the follower had every order 1 ms after the last ack (median; includes waiting for its own matcher to finish).

4 connections, 200000 orders per run, 5 runs per configuration, closed loop, as fast as possible. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| no replication | 18310 | 18195 to 18478 | 195.3 | 813.0 | 1232.8 | 2001147.8 | 3185621.5 | 3023626 to 3385397 |
| with a follower | 12279 | 12234 to 12331 | 283.9 | 1212.4 | 1830.5 | 1178.7 | 7033.7 | 5381 to 49651 |

with a follower: the follower had every order 1 ms after the last ack (median; includes waiting for its own matcher to finish).

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
