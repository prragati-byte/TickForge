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
