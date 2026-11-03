//! SSTable write cost, normal path vs io_uring. Output is markdown.
//!
//!   cargo run --release --example sstable_io_bench -- <directory on the disk to test>
use std::path::Path;
use std::time::Instant;
use tickforge_db::{Database, IoBackend, SsTable, Trade};

fn trade(id: u64) -> Trade {
    Trade {
        trade_id: id,
        symbol: "AAPL".to_string(),
        price_cents: 10_000 + id as i64 % 100,
        quantity: 1 + id % 50,
        buy_order_id: id * 2,
        sell_order_id: id * 2 + 1,
        buyer_id: id % 24,
        seller_id: (id + 1) % 24,
        timestamp_ms: 1_000 + id,
    }
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

/// Compact eight tables of `each` trades. Returns milliseconds.
fn compaction_ms(dir: &Path, io: IoBackend, each: u64) -> f64 {
    let _ = std::fs::remove_dir_all(dir);
    let mut db = Database::open_with(dir, io).unwrap();
    let mut id = 1;
    for _ in 0..7 {
        for _ in 0..each {
            db.insert_trade(trade(id)).unwrap();
            id += 1;
        }
        db.flush().unwrap();
    }
    let t0 = Instant::now();
    assert!(db.compact().unwrap() >= 2);
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    drop(db);
    let _ = std::fs::remove_dir_all(dir);
    ms
}

fn main() {
    let root = std::env::args().nth(1).expect("usage: sstable_io_bench <directory>");
    let root = Path::new(&root);
    std::fs::create_dir_all(root).unwrap();
    const RUNS: usize = 11;

    let direct = tickforge_db::uring::write_file(&root.join("probe"), &[0u8; 8192]).unwrap();
    std::fs::remove_file(root.join("probe")).unwrap();
    println!(
        "Median of {RUNS} runs. Writing includes fsync and rename. One thread, nothing else running. \
         O_DIRECT on this file system: {}.",
        if direct { "used" } else { "not available, so the page cache was used" }
    );
    println!();
    println!("| Operation | Normal write (ms) | io_uring (ms) |");
    println!("|---|---|---|");
    for (label, n) in [("Write 10,000 trades", 10_000u64), ("Write 1,000,000 trades", 1_000_000)] {
        let trades: Vec<Trade> = (1..=n).map(trade).collect();
        let mut plain = Vec::new();
        let mut uring = Vec::new();
        for _ in 0..RUNS {
            for (io, out) in [(IoBackend::Standard, &mut plain), (IoBackend::Uring, &mut uring)] {
                let path = root.join("bench.tfs");
                let t0 = Instant::now();
                SsTable::write_with(&path, &trades, io).unwrap();
                out.push(t0.elapsed().as_secs_f64() * 1000.0);
                std::fs::remove_file(&path).unwrap();
            }
        }
        println!("| {label} | {:.1} | {:.1} |", median(plain), median(uring));
    }
    let mut plain = Vec::new();
    let mut uring = Vec::new();
    for _ in 0..RUNS {
        plain.push(compaction_ms(&root.join("db"), IoBackend::Standard, 2_000));
        uring.push(compaction_ms(&root.join("db"), IoBackend::Uring, 2_000));
    }
    println!("| Compact 7 tables, 14,000 trades | {:.1} | {:.1} |", median(plain), median(uring));
}
