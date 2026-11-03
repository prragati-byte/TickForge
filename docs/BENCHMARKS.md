# Benchmarks

Written by `./build.sh bench`. The numbers below are the engine benchmark's own output,
measured on the machine described here; they will differ on other machines.

## Machine

| | |
|---|---|
| Date (UTC) | 2026-11-03 20:58 |
| CPU | 12th Gen Intel(R) Core(TM) i5-12450H |
| Logical cores | 12 |
| Memory | 7.6 GiB |
| OS | Linux 6.18.54.1-microsoft-standard-WSL2 |
| Compiler | c++ (Ubuntu 15.2.0-16ubuntu1) 15.2.0 |
| Build type | Release |
| Source commit | ca29c83 |

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
| lock-free | 1 | 2.23 | 64 | 12608 |
| mutex | 1 | 3.10 | 90 | 861 |
| elastic ring | 1 | 15.07 | 29 | 103 |
| lock-free | 2 | 4.19 | 60 | 1436 |
| mutex | 2 | 6.15 | 40 | 3660 |
| elastic ring | 2 | 14.34 | 118 | 173 |
| lock-free | 4 | 3.29 | 567 | 4166 |
| mutex | 4 | 4.52 | 56 | 21659 |
| elastic ring | 4 | 20.72 | 155 | 272 |
| lock-free | 8 | 2.59 | 1161 | 28718 |
| mutex | 8 | 3.97 | 69 | 42112 |
| elastic ring | 8 | 25.07 | 194 | 717 |

## Queue burst: consumer starts 20 ms late

4 producers, 250000 items each. Elastic rings are sized so the burst fits (2^21 slots), half fits (2^18), or barely fits at all (2^8).

| Queue | enqueue P50 (ns) | enqueue P99 (ns) | Drain (ms) | Items through overflow |
|---|---|---|---|---|
| lock-free list | 568 | 4014 | 272.2 | every item is a heap node |
| elastic ring 2^21 | 151 | 262 | 22.1 | 0 |
| elastic ring 2^18 | 158 | 411 | 29.7 | 121611 |
| elastic ring 2^8 | 225 | 641 | 114.4 | 999744 |

## Order book: std::map vs dense array

1000000 operations (about 10% cancels) on one symbol, prices within +-10 cents of a drifting mid price. One thread.

| Book | Throughput (M ops/s) | P50 (ns) | P99 (ns) | Trades |
|---|---|---|---|---|
| MapBook (std::map) | 9.85 | 109 | 360 | 822471 |
| DenseBook (array) | 14.73 | 84 | 333 | 822471 |

## WAL append: write() vs io_uring

200000 frames per run, 5 runs each, taking turns, one thread, no fsync. One frame per system call and the call waits for the result, because the engine must not acknowledge an order before its frame is written. Per-call time includes about 20-30 ns for reading the clock.

| Backend | P50 (ns) | P99 (ns) | P99.9 (ns) | Frames/s |
|---|---|---|---|---|
| write() | 528 | 1891 | 4043 | 1364325 |
| io_uring | 37310 | 71304 | 345662 | 25459 |

## Whole server, by engine flag

Measured over TCP by `engine/bench/server_bench.cpp`. RTT is send to ack. The matcher columns are
the server's own numbers, from queue push to matching finished; they show a backlog when the load is
more than the matching thread can take.

### Core pinning

4 connections, 30000 orders per run, 15 runs per configuration, paced at 2000 orders/s in total. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| unpinned | 2000 | 2000 to 2000 | 121.5 | 429.7 | 809.6 | 46.3 | 275.9 | 150 to 324 |
| pinned | 2000 | 2000 to 2000 | 132.1 | 453.8 | 930.5 | 41.9 | 298.1 | 223 to 345 |

4 connections, 200000 orders per run, 7 runs per configuration, closed loop, as fast as possible. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| unpinned | 18107 | 17674 to 18385 | 194.3 | 824.1 | 1263.4 | 2035556.2 | 3199205.7 | 3116260 to 3280375 |
| pinned | 18281 | 18028 to 18411 | 195.0 | 813.2 | 1222.7 | 2027700.9 | 3135648.1 | 3017725 to 3421110 |

### WAL writes

4 connections, 30000 orders per run, 9 runs per configuration, paced at 2000 orders/s in total. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| write() | 2000 | 2000 to 2000 | 137.8 | 453.5 | 853.6 | 44.3 | 299.9 | 226 to 414 |
| io_uring | 2000 | 2000 to 2000 | 249.6 | 697.8 | 1272.3 | 42.0 | 219.9 | 96 to 262 |

4 connections, 200000 orders per run, 5 runs per configuration, closed loop, as fast as possible. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| write() | 18294 | 18226 to 18433 | 190.9 | 818.5 | 1236.8 | 2032452.8 | 3206348.2 | 3157021 to 3292963 |
| io_uring | 10285 | 9620 to 10480 | 91.4 | 2998.6 | 5087.3 | 22.0 | 532.1 | 444 to 619 |

### Replication

4 connections, 30000 orders per run, 9 runs per configuration, paced at 2000 orders/s in total. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| no replication | 2000 | 2000 to 2000 | 153.2 | 508.2 | 1036.2 | 47.9 | 317.8 | 287 to 385 |
| --replicate, no follower | 2000 | 2000 to 2000 | 143.4 | 489.1 | 1057.5 | 46.0 | 309.3 | 160 to 539 |
| with a follower | 2000 | 1991 to 2000 | 170.6 | 506.8 | 1301.8 | 46.1 | 372.6 | 155 to 464 |

with a follower: the follower had every order 1 ms after the last ack (median; includes waiting for its own matcher to finish).

4 connections, 200000 orders per run, 5 runs per configuration, closed loop, as fast as possible. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| no replication | 17327 | 16821 to 18005 | 204.7 | 868.8 | 1310.7 | 2091413.2 | 3315111.0 | 3022408 to 3363281 |
| with a follower | 11872 | 11780 to 12036 | 292.9 | 1262.1 | 1904.5 | 1002.1 | 5189.6 | 4185 to 8494 |

with a follower: the follower had every order 1 ms after the last ack (median; includes waiting for its own matcher to finish).

### Queue

4 connections, 30000 orders per run, 9 runs per configuration, paced at 2000 orders/s in total. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| lock-free list | 2000 | 2000 to 2000 | 137.1 | 449.4 | 904.8 | 47.0 | 281.2 | 112 to 325 |
| elastic ring | 2000 | 1999 to 2000 | 138.2 | 483.2 | 879.5 | 45.7 | 297.6 | 109 to 322 |

4 connections, 200000 orders per run, 5 runs per configuration, closed loop, as fast as possible. Median over the runs; throughput also shows the slowest and fastest run.

| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |
|---|---|---|---|---|---|---|---|---|
| lock-free list | 17587 | 17382 to 17847 | 196.7 | 851.9 | 1283.6 | 2086340.7 | 3218754.3 | 2857762 to 3390232 |
| elastic ring | 17823 | 16857 to 18172 | 198.4 | 825.6 | 1257.1 | 2054699.6 | 3245896.7 | 2967809 to 3419874 |

### SSTable and compaction writes: normal path vs io_uring

Median of 11 runs. Writing includes fsync and rename. One thread, nothing else running. O_DIRECT on this file system: used.

| Operation | Normal write (ms) | io_uring (ms) |
|---|---|---|
| Write 10,000 trades | 6.9 | 9.3 |
| Write 1,000,000 trades | 164.4 | 215.2 |
| Compact 7 tables, 14,000 trades | 13.1 | 15.0 |


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
