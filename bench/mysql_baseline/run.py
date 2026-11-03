#!/usr/bin/env python3
"""TickForge database vs MySQL: same trades, stated durability settings.

Run through `./build.sh bench-mysql`. Writes docs/benchmarks/mysql.md.

MySQL is unpacked from the distribution's packages into .run/mysql (no root, nothing
installed outside this folder) unless TICKFORGE_MYSQLD points at an existing mysqld.
"""
import json
import os
import platform
import shutil
import signal
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUN = ROOT / ".run" / "mysql"
BENCH = ROOT / ".run" / "build" / "mysql-bench" / "release" / "mysql_baseline"
OUTPUT = ROOT / "docs" / "benchmarks" / "mysql.md"

SINGLE_TRADES = 200_000
BATCH_SIZE = 100
BATCH_TRADES = 200_000
STRICT_SINGLE_TRADES = 5_000  # about 8 ms per commit on this disk; fewer trades, same measurement
# One short of a memtable flush (every 10,000 trades), so the database has the most
# it can ever have to replay from its log.
RECOVERY_TRADES = 99_999
RUNS = 3

# name, what a commit guarantees, mysqld settings
MYSQL_CONFIGS = [
    ("MySQL, no binlog, flush=2", "page cache: survives a process crash, not a power cut",
     ["--innodb-flush-log-at-trx-commit=2", "--disable-log-bin"]),
    ("MySQL, binlog, flush=2, sync_binlog=0", "page cache: survives a process crash, not a power cut",
     ["--innodb-flush-log-at-trx-commit=2", "--log-bin=binlog", "--sync-binlog=0"]),
    ("MySQL, binlog, flush=1, sync_binlog=1", "fsync: also survives a power cut (stronger than TickForge)",
     ["--innodb-flush-log-at-trx-commit=1", "--log-bin=binlog", "--sync-binlog=1"]),
]
COMMON = ["--innodb-buffer-pool-size=1G", "--innodb-redo-log-capacity=1G", "--skip-networking",
          "--mysqlx=OFF", "--performance-schema=OFF", "--secure-file-priv=NULL"]

PACKAGES = ["mysql-server-core", "mysql-client-core", "libicu78", "libprotobuf-lite32t64", "libaio1t64",
            "libnuma1", "libgoogle-perftools4t64", "libtcmalloc-minimal4t64", "libunwind8", "libmecab2"]


def find_mysqld():
    """Return (path to mysqld, extra environment)."""
    if os.environ.get("TICKFORGE_MYSQLD"):
        return os.environ["TICKFORGE_MYSQLD"], {}
    root = RUN / "root"
    mysqld = root / "usr/sbin/mysqld"
    if not mysqld.exists():
        if not shutil.which("apt-get"):
            sys.exit("No mysqld found. Set TICKFORGE_MYSQLD to the path of a mysqld binary.")
        debs = RUN / "debs"
        debs.mkdir(parents=True, exist_ok=True)
        subprocess.run(["apt-get", "download", *PACKAGES], cwd=debs, check=True)
        root.mkdir(exist_ok=True)
        for deb in debs.glob("*.deb"):
            subprocess.run(["dpkg", "-x", str(deb), str(root)], check=True)
    libs = f"{root}/usr/lib/x86_64-linux-gnu:{root}/lib/x86_64-linux-gnu"
    return str(mysqld), {"LD_LIBRARY_PATH": libs}


class Mysqld:
    def __init__(self, binary, env, datadir, flags):
        self.binary, self.env, self.datadir, self.flags = binary, {**os.environ, **env}, datadir, flags
        self.socket = str(RUN / "s.sock")
        self.proc = None

    def args(self):
        return [self.binary, "--no-defaults", f"--datadir={self.datadir}", f"--socket={self.socket}",
                f"--pid-file={RUN}/mysqld.pid", f"--log-error={RUN}/mysqld.err", *COMMON, *self.flags]

    def initialize(self):
        shutil.rmtree(self.datadir, ignore_errors=True)
        subprocess.run([self.binary, "--no-defaults", "--initialize-insecure",
                        f"--datadir={self.datadir}", f"--log-error={RUN}/init.err", *self.flags],
                       env=self.env, check=True)

    def start(self):
        """Returns seconds until the server accepts connections."""
        t0 = time.monotonic()
        self.proc = subprocess.Popen(self.args(), env=self.env)
        probe = [self.binary.replace("sbin/mysqld", "bin/mysql"), "--no-defaults", "-uroot",
                 f"--socket={self.socket}", "-e", "CREATE DATABASE IF NOT EXISTS bench"]
        while time.monotonic() - t0 < 300:
            if self.proc.poll() is not None:
                sys.exit(f"mysqld stopped while starting; see {RUN}/mysqld.err")
            if subprocess.run(probe, env=self.env, capture_output=True).returncode == 0:
                return time.monotonic() - t0
            time.sleep(0.02)
        sys.exit("mysqld did not start in 300 seconds")

    def stop(self):
        self.proc.terminate()
        self.proc.wait()

    def kill9(self):
        self.proc.send_signal(signal.SIGKILL)
        self.proc.wait()


def bench(*args):
    out = subprocess.run([str(BENCH), *map(str, args)], check=True, capture_output=True, text=True).stdout
    return json.loads(out.strip().splitlines()[-1])


def med(rows, key):
    return statistics.median(r[key] for r in rows)


def row(name, durability, rows, batch):
    unit = "1" if batch == 1 else str(batch)
    return (f"| {name} | {durability} | {unit} | {med(rows,'trades_per_sec'):,.0f} | {med(rows,'p50_us'):,.1f} | "
            f"{med(rows,'p99_us'):,.1f} | {med(rows,'p9999_us'):,.1f} | {med(rows,'cpu_us_per_trade'):.1f} | "
            f"{med(rows,'bytes_per_trade'):,.0f} |")


def tickforge_recovery(work):
    data = work / "recovery"
    shutil.rmtree(data, ignore_errors=True)
    proc = subprocess.Popen([str(BENCH), "tickforge-load-and-wait", str(data), str(RECOVERY_TRADES)],
                            stdout=subprocess.PIPE, text=True)
    assert proc.stdout.readline().strip() == "loaded"
    proc.send_signal(signal.SIGKILL)
    proc.wait()
    result = bench("tickforge-recover", data, RECOVERY_TRADES)
    shutil.rmtree(data, ignore_errors=True)
    return result["recovery_secs"]


def main():
    binary, env = find_mysqld()
    work = ROOT / ".run" / "mysql-work"
    work.mkdir(parents=True, exist_ok=True)
    RUN.mkdir(parents=True, exist_ok=True)
    version = subprocess.run([binary, "--no-defaults", "--version"], env={**os.environ, **env},
                             capture_output=True, text=True).stdout.strip().split(" for ")[0]
    version = version[version.find("Ver "):]
    # Results are kept after each system, so a failed run can continue where it stopped.
    progress = RUN / "progress.json"
    done = json.loads(progress.read_text()) if progress.exists() else {}

    def save(key, value):
        done[key] = value
        progress.write_text(json.dumps(done))

    table, recovery = [], []

    tf_durable = "page cache: survives a process crash, not a power cut"
    if "tickforge" not in done:
        rows = []
        for batch, trades in ((1, SINGLE_TRADES), (BATCH_SIZE, BATCH_TRADES)):
            runs = []
            for _ in range(RUNS):
                data = work / "tickforge"
                shutil.rmtree(data, ignore_errors=True)
                runs.append(bench("tickforge-insert", data, trades, batch))
            shutil.rmtree(work / "tickforge", ignore_errors=True)
            rows.append(row("TickForge database (LSM)", tf_durable, runs, batch))
        save("tickforge", {"rows": rows,
                           "recovery": statistics.median(tickforge_recovery(work) for _ in range(RUNS))})
    table.extend(done["tickforge"]["rows"])
    tf_recovery = done["tickforge"]["recovery"]

    for name, durability, flags in MYSQL_CONFIGS:
        if name in done:
            table.extend(done[name]["rows"])
            recovery.append(done[name]["recovery"])
            continue
        server = Mysqld(binary, env, work / "datadir", flags)
        server.initialize()
        clean_start = server.start()
        strict = "flush=1" in name
        results = {1: [], BATCH_SIZE: []}
        for _ in range(RUNS):
            results[1].append(bench("mysql-insert", server.socket, server.proc.pid,
                                    STRICT_SINGLE_TRADES if strict else SINGLE_TRADES, 1))
            results[BATCH_SIZE].append(bench("mysql-insert", server.socket, server.proc.pid,
                                             BATCH_TRADES, BATCH_SIZE))
        rows = [row(name, durability, results[1], 1), row(name, durability, results[BATCH_SIZE], BATCH_SIZE)]
        table.extend(rows)

        # Recovery: fixed number of trades, kill -9, time until the server answers.
        times = []
        for _ in range(RUNS):
            subprocess.run([str(BENCH), "mysql-load", server.socket, str(RECOVERY_TRADES)], check=True,
                           capture_output=True)
            server.kill9()
            times.append(server.start())
            bench("mysql-count", server.socket, RECOVERY_TRADES)
        server.stop()
        restart = server.start()  # after a clean stop: no crash recovery to do
        server.stop()
        recovery.append(f"| {name} | {statistics.median(times):.2f} | {restart:.2f} |")
        save(name, {"rows": rows, "recovery": recovery[-1]})
        print(f"done: {name}", flush=True)
    shutil.rmtree(work, ignore_errors=True)
    progress.unlink()

    disk = ROOT / ".run"
    lines = [
        "## TickForge database vs MySQL", "",
        "Written by `./build.sh bench-mysql` (`bench/mysql_baseline/`). This compares a narrow job, "
        "storing fixed-schema trade records. It says nothing about general database quality: MySQL also "
        "provides SQL, secondary indexes, multi-row transactions, replication tooling and backups, and "
        "TickForge's database provides none of those.", "",
        "| | |", "|---|---|",
        f"| Date (UTC) | {time.strftime('%Y-%m-%d %H:%M', time.gmtime())} |",
        f"| MySQL | {version}, from the Ubuntu packages, InnoDB |",
        f"| MySQL settings, all runs | `{' '.join(COMMON)}`, everything else default |",
        f"| Client | One Rust thread. MySQL over a Unix socket (`mysql` crate); TickForge called in-process |",
        f"| Disk | ext4 on the WSL2 virtual disk, `{disk.relative_to(ROOT)}/`, same disk for both systems |",
        f"| Kernel | {platform.release()} |",
        f"| Workload | {SINGLE_TRADES:,} trades one per commit ({STRICT_SINGLE_TRADES:,} for fsync MySQL), and "
        f"{BATCH_TRADES:,} trades in commits of {BATCH_SIZE}; same generator, 9 columns, primary key on `trade_id` |",
        f"| Repeats | {RUNS} runs, median shown |", "",
        "Latency is per commit: `insert_trade` returning, or `COMMIT` returning. TickForge has no multi-insert, "
        "so its \"commit of 100\" is 100 single inserts, each written to its log. MySQL commits are autocommit "
        "`INSERT`s, one socket round trip each. CPU includes mysqld and the client. Bytes are what the disk "
        "received (`/proc/diskstats`, file system journal included) until dirty pages, the memtable and the "
        "page cache were written out, on an otherwise idle machine.", "",
        "**Compare like with like.** TickForge's database acknowledges before an fsync, so the fair MySQL rows "
        "are the two with `flush=2`. The `flush=1` row is stronger than anything TickForge offers and is shown "
        "for reference only. fsync speed on a WSL2 virtual disk is not representative of a real NVMe drive.", "",
        "| System | A commit means | Trades per commit | Trades/s | P50 (us) | P99 (us) | P99.99 (us) | "
        "CPU per trade (us) | Bytes written per trade |",
        "|---|---|---|---|---|---|---|---|---|",
        *table, "",
        f"### Recovery after kill -9, {RECOVERY_TRADES:,} trades stored", "",
        "Time from process start to \"ready\", and every trade verified present afterwards. The database's "
        "open reads all its SSTables and replays 9,999 trades from its log; MySQL's clean restart shows how much "
        "of its time is normal startup. The database has no clean shutdown, so it always takes the same path.", "",
        "| System | After kill -9 (s) | After clean stop (s) |", "|---|---|---|",
        f"| TickForge database (LSM) | {tf_recovery:.2f} | same path |",
        *recovery, "",
        "MyRocks, which the project document suggests as the closest baseline, is not in the Ubuntu packages and "
        "was not run.", "",
    ]
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text("\n".join(lines))
    print(f"Wrote {OUTPUT}")


if __name__ == "__main__":
    main()
