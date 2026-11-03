//! The measuring half of the MySQL baseline. `run.py` starts mysqld with each
//! configuration and calls this program; results come back as one JSON line.
//!
//! Both systems get the same trades from the same generator, inserted by one
//! thread. "Commit" means: TickForge `insert_trade` returned, or a MySQL autocommit
//! `INSERT` returned, one socket round trip per commit (the cheapest way to commit).
//! TickForge is called in-process (that is how exchange-api uses it); MySQL is
//! reached over a Unix socket.
//!
//!   mysql_baseline tickforge-insert <dir> <trades> <batch>
//!   mysql_baseline mysql-insert <socket> <mysqld pid> <trades> <batch>
//!   mysql_baseline tickforge-load-and-wait <dir> <trades>   (killed by the caller)
//!   mysql_baseline tickforge-recover <dir> <expected trades>
//!   mysql_baseline mysql-load <socket> <trades>
//!   mysql_baseline mysql-count <socket> <expected trades>
use mysql::prelude::Queryable;
use mysql::{Conn, OptsBuilder};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::Instant;
use tickforge_db::{Database, Trade};

const SYMBOLS: [&str; 5] = ["AAPL", "MSFT", "NVDA", "GOOG", "AMZN"];

/// Small deterministic generator: both systems store exactly the same trades.
struct Gen(u64);
impl Gen {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn trade(&mut self, id: u64) -> Trade {
        Trade {
            trade_id: id,
            symbol: SYMBOLS[(self.next() % 5) as usize].to_string(),
            price_cents: 10_000 + (self.next() % 2_000) as i64,
            quantity: 1 + self.next() % 1_000,
            buy_order_id: id * 2,
            sell_order_id: id * 2 + 1,
            buyer_id: self.next() % 24,
            seller_id: self.next() % 24,
            timestamp_ms: 1_767_225_600_000 + id,
        }
    }
}

fn percentile(sorted: &[u64], p: f64) -> u64 {
    sorted[((sorted.len() as f64 * p) as usize).min(sorted.len() - 1)]
}

/// utime + stime of a process in seconds, from /proc.
fn cpu_seconds(pid: &str) -> f64 {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
    let rest = text.rsplit(')').next().unwrap_or("");
    let fields: Vec<&str> = rest.split_whitespace().collect();
    let ticks = |i: usize| fields.get(i).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    (ticks(11) + ticks(12)) / 100.0
}

/// Bytes written to the disk that holds `path`, as the kernel counts them, after
/// pushing out everything still in the page cache. This is what the device really
/// gets, file system journal included. The machine must otherwise be idle: this
/// WSL2 kernel has no per-process /proc/<pid>/io.
fn disk_written_bytes(path: &Path) -> u64 {
    std::process::Command::new("sync").status().expect("sync");
    let dev = std::fs::metadata(path).expect("stat").dev();
    let (major, minor) = ((dev >> 8) & 0xfff, (dev & 0xff) | ((dev >> 12) & 0xfff00));
    let stats = std::fs::read_to_string("/proc/diskstats").expect("diskstats");
    for line in stats.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() > 9 && f[0] == major.to_string() && f[1] == minor.to_string() {
            return f[9].parse::<u64>().expect("sectors") * 512;
        }
    }
    panic!("no line for device {major}:{minor} in /proc/diskstats");
}

fn dir_bytes(dir: &Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if let Ok(m) = e.metadata() {
                total += if m.is_dir() { dir_bytes(&e.path()) } else { m.len() };
            }
        }
    }
    total
}

struct Measured {
    secs: f64,
    samples: Vec<u64>,
}

fn print_result(m: &mut Measured, trades: u64, batch: u64, cpu: f64, written: u64) {
    m.samples.sort_unstable();
    println!(
        "{{\"trades\":{},\"batch\":{},\"trades_per_sec\":{:.0},\"p50_us\":{:.1},\"p99_us\":{:.1},\"p9999_us\":{:.1},\"cpu_seconds\":{:.2},\"cpu_us_per_trade\":{:.1},\"write_bytes\":{},\"bytes_per_trade\":{:.0}}}",
        trades,
        batch,
        trades as f64 / m.secs,
        percentile(&m.samples, 0.50) as f64 / 1000.0,
        percentile(&m.samples, 0.99) as f64 / 1000.0,
        percentile(&m.samples, 0.9999) as f64 / 1000.0,
        cpu,
        cpu * 1e6 / trades as f64,
        written,
        written as f64 / trades as f64
    );
}

// ---- TickForge ------------------------------------------------------------------

fn tickforge_insert(dir: &Path, trades: u64, batch: u64) {
    let mut db = Database::open(dir).expect("open");
    let (cpu0, wr0) = (cpu_seconds("self"), disk_written_bytes(dir));
    let mut gen = Gen(88172645463325252);
    let mut samples = Vec::with_capacity((trades / batch + 1) as usize);
    let t0 = Instant::now();
    let mut id = 1;
    while id <= trades {
        let s = Instant::now();
        // The database has no multi-insert: a batch is `batch` single inserts.
        for _ in 0..batch {
            db.insert_trade(gen.trade(id)).expect("insert");
            id += 1;
        }
        samples.push(s.elapsed().as_nanos() as u64);
    }
    let secs = t0.elapsed().as_secs_f64();
    // Everything left in memory goes to an SSTable, so the bytes below are complete.
    db.flush().expect("flush");
    let cpu = cpu_seconds("self") - cpu0;
    let written = disk_written_bytes(dir) - wr0;
    assert_eq!(db.count(), trades);
    print_result(&mut Measured { secs, samples }, trades, batch, cpu, written);
}

fn tickforge_load_and_wait(dir: &Path, trades: u64) {
    let mut db = Database::open(dir).expect("open");
    let mut gen = Gen(88172645463325252);
    for id in 1..=trades {
        db.insert_trade(gen.trade(id)).expect("insert");
    }
    println!("loaded");
    std::thread::sleep(std::time::Duration::from_secs(3600));
    drop(db);
}

fn tickforge_recover(dir: &Path, expected: u64) {
    let t0 = Instant::now();
    let db = Database::open(dir).expect("open");
    let secs = t0.elapsed().as_secs_f64();
    assert_eq!(db.count(), expected, "trades lost");
    println!("{{\"recovery_secs\":{secs:.3},\"bytes_on_disk\":{}}}", dir_bytes(dir));
}

// ---- MySQL ----------------------------------------------------------------------

fn connect(socket: &str) -> Conn {
    let opts = OptsBuilder::new()
        .socket(Some(socket))
        .user(Some("root"))
        .db_name(Some("bench"));
    Conn::new(opts).expect("connect to mysqld")
}

const INSERT_HEAD: &str = "INSERT INTO trades (trade_id, symbol, price_cents, quantity, \
    buy_order_id, sell_order_id, buyer_id, seller_id, timestamp_ms) VALUES ";

fn values(t: &Trade) -> String {
    format!(
        "({},'{}',{},{},{},{},{},{},{})",
        t.trade_id, t.symbol, t.price_cents, t.quantity, t.buy_order_id, t.sell_order_id,
        t.buyer_id, t.seller_id, t.timestamp_ms
    )
}

fn create_table(conn: &mut Conn) {
    conn.query_drop("DROP TABLE IF EXISTS trades").unwrap();
    conn.query_drop(
        "CREATE TABLE trades (
           trade_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
           symbol VARCHAR(32) NOT NULL,
           price_cents BIGINT NOT NULL,
           quantity BIGINT UNSIGNED NOT NULL,
           buy_order_id BIGINT UNSIGNED NOT NULL,
           sell_order_id BIGINT UNSIGNED NOT NULL,
           buyer_id BIGINT UNSIGNED NOT NULL,
           seller_id BIGINT UNSIGNED NOT NULL,
           timestamp_ms BIGINT UNSIGNED NOT NULL
         ) ENGINE=InnoDB",
    )
    .unwrap();
}

fn mysql_insert(socket: &str, pid: &str, trades: u64, batch: u64) {
    let mut conn = connect(socket);
    create_table(&mut conn);
    let disk = Path::new(socket).parent().expect("socket directory");
    let (cpu0, wr0) = (cpu_seconds(pid), disk_written_bytes(disk));
    let client0 = cpu_seconds("self");
    let mut gen = Gen(88172645463325252);
    let mut samples = Vec::with_capacity((trades / batch + 1) as usize);
    let t0 = Instant::now();
    let mut id = 1;
    while id <= trades {
        let mut sql = String::with_capacity(INSERT_HEAD.len() + 90 * batch as usize);
        sql.push_str(INSERT_HEAD);
        for i in 0..batch {
            if i > 0 {
                sql.push(',');
            }
            sql.push_str(&values(&gen.trade(id)));
            id += 1;
        }
        let s = Instant::now();
        conn.query_drop(&sql).unwrap(); // autocommit: this statement is one commit
        samples.push(s.elapsed().as_nanos() as u64);
    }
    let secs = t0.elapsed().as_secs_f64();
    // Write out every dirty page so the bytes below are complete.
    conn.query_drop("SET GLOBAL innodb_max_dirty_pages_pct = 0").unwrap();
    conn.query_drop("SET GLOBAL innodb_max_dirty_pages_pct_lwm = 0").unwrap();
    loop {
        let dirty: Option<(String, u64)> = conn
            .query_first("SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_pages_dirty'")
            .unwrap();
        if dirty.map_or(0, |d| d.1) == 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    conn.query_drop("SET GLOBAL innodb_max_dirty_pages_pct = 90").unwrap();
    let cpu = cpu_seconds(pid) - cpu0 + cpu_seconds("self") - client0;
    let written = disk_written_bytes(disk) - wr0;
    let count: u64 = conn.query_first("SELECT COUNT(*) FROM trades").unwrap().unwrap();
    assert_eq!(count, trades);
    print_result(&mut Measured { secs, samples }, trades, batch, cpu, written);
}

/// Insert the fixed number of trades for the recovery test, 100 per transaction,
/// so that loading is quick even when every commit waits for fsync.
fn mysql_load(socket: &str, trades: u64) {
    let mut conn = connect(socket);
    create_table(&mut conn);
    let mut gen = Gen(88172645463325252);
    let mut id = 1;
    while id <= trades {
        let mut sql = String::from(INSERT_HEAD);
        for i in 0..100.min(trades - id + 1) {
            if i > 0 {
                sql.push(',');
            }
            sql.push_str(&values(&gen.trade(id)));
            id += 1;
        }
        conn.query_drop(&sql).unwrap();
    }
    println!("loaded");
}

fn mysql_count(socket: &str, expected: u64) {
    let mut conn = connect(socket);
    let count: u64 = conn.query_first("SELECT COUNT(*) FROM trades").unwrap().unwrap();
    assert_eq!(count, expected, "trades lost");
    println!("{{\"count\":{count}}}");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let n = |i: usize| args[i].parse::<u64>().expect("number");
    match args.get(1).map(String::as_str) {
        Some("tickforge-insert") => tickforge_insert(Path::new(&args[2]), n(3), n(4)),
        Some("tickforge-load-and-wait") => tickforge_load_and_wait(Path::new(&args[2]), n(3)),
        Some("tickforge-recover") => tickforge_recover(Path::new(&args[2]), n(3)),
        Some("mysql-insert") => mysql_insert(&args[2], &args[3], n(4), n(5)),
        Some("mysql-load") => mysql_load(&args[2], n(3)),
        Some("mysql-count") => mysql_count(&args[2], n(3)),
        _ => {
            eprintln!("see the comment at the top of src/main.rs");
            std::process::exit(2);
        }
    }
}
