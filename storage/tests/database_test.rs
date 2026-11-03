//! Tests for the whole database through its public API.

use std::fs;
use std::io::Write;
use tickforge_db::{Database, Trade};

fn trade(id: u64, ts: u64, symbol: &str) -> Trade {
    Trade {
        trade_id: id,
        symbol: symbol.to_string(),
        price_cents: 10_000 + id as i64,
        quantity: 1 + id % 100,
        buy_order_id: id * 2,
        sell_order_id: id * 2 + 1,
        buyer_id: id % 24,
        seller_id: (id + 7) % 24,
        timestamp_ms: ts,
    }
}

fn sst_files(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n.ends_with(".tfs"))
        .collect();
    names.sort();
    names
}

#[test]
fn insert_get_count_and_replace() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Database::open(dir.path()).unwrap();
    assert_eq!(db.count(), 0);
    assert!(db.get_trade(1).unwrap().is_none());

    db.insert_trade(trade(1, 100, "AAPL")).unwrap();
    db.insert_trade(trade(2, 101, "MSFT")).unwrap();
    assert_eq!(db.count(), 2);
    assert_eq!(db.get_trade(2).unwrap().unwrap(), trade(2, 101, "MSFT"));

    // same id again replaces it and does not change the count
    let mut again = trade(2, 105, "MSFT");
    again.quantity = 999;
    db.insert_trade(again.clone()).unwrap();
    assert_eq!(db.count(), 2);
    assert_eq!(db.get_trade(2).unwrap().unwrap(), again);
}

#[test]
fn bad_trades_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Database::open(dir.path()).unwrap();
    let mut t = trade(1, 100, "AAPL");
    t.quantity = 0;
    assert!(db.insert_trade(t).is_err());
    let mut t = trade(1, 100, "AAPL");
    t.price_cents = -5;
    assert!(db.insert_trade(t).is_err());
    assert!(db.insert_trade(trade(1, 100, "")).is_err());
    assert_eq!(db.count(), 0);
}

#[test]
fn reopen_after_crash_without_flush() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut db = Database::open(dir.path()).unwrap();
        for i in 1..=50 {
            db.insert_trade(trade(i, 1_000 + i, "AAPL")).unwrap();
        }
        // dropped without flush(): like a crash, only the log has the data
    }
    assert!(sst_files(dir.path()).is_empty());
    let db = Database::open(dir.path()).unwrap();
    assert_eq!(db.count(), 50);
    assert_eq!(db.get_trade(37).unwrap().unwrap(), trade(37, 1_037, "AAPL"));
}

#[test]
fn reopen_after_flush_and_more_inserts() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut db = Database::open(dir.path()).unwrap();
        for i in 1..=20 {
            db.insert_trade(trade(i, 1_000 + i, "AAPL")).unwrap();
        }
        db.flush().unwrap();
        for i in 21..=30 {
            db.insert_trade(trade(i, 1_000 + i, "MSFT")).unwrap();
        }
    }
    assert_eq!(sst_files(dir.path()), vec!["sst-1.tfs"]);
    let db = Database::open(dir.path()).unwrap();
    assert_eq!(db.count(), 30);
    assert_eq!(db.range(0, u64::MAX, None).unwrap().len(), 30);
}

#[test]
fn half_written_log_tail_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut db = Database::open(dir.path()).unwrap();
        for i in 1..=10 {
            db.insert_trade(trade(i, 1_000 + i, "AAPL")).unwrap();
        }
    }
    // simulate a crash in the middle of the next append
    let log = dir.path().join("wal.log");
    let good_len = fs::metadata(&log).unwrap().len();
    fs::OpenOptions::new()
        .append(true)
        .open(&log)
        .unwrap()
        .write_all(&[200, 0, 0, 0, 1, 2, 3, 4, 5])
        .unwrap();

    let mut db = Database::open(dir.path()).unwrap();
    assert_eq!(db.count(), 10);
    assert_eq!(fs::metadata(&log).unwrap().len(), good_len);
    // and the log is usable again
    db.insert_trade(trade(11, 1_011, "AAPL")).unwrap();
    drop(db);
    assert_eq!(Database::open(dir.path()).unwrap().count(), 11);
}

#[test]
fn flush_writes_a_table_and_empties_the_log() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Database::open(dir.path()).unwrap();
    for i in 1..=5 {
        db.insert_trade(trade(i, 1_000 + i, "AAPL")).unwrap();
    }
    db.flush().unwrap();
    assert_eq!(sst_files(dir.path()), vec!["sst-1.tfs"]);
    assert_eq!(fs::metadata(dir.path().join("wal.log")).unwrap().len(), 0);
    assert_eq!(db.get_trade(3).unwrap().unwrap(), trade(3, 1_003, "AAPL"));
    db.flush().unwrap(); // nothing to flush: no new file
    assert_eq!(sst_files(dir.path()).len(), 1);
}

#[test]
fn range_queries() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Database::open(dir.path()).unwrap();
    // three generations: two SSTables and the memtable, mixed symbols
    for i in 1..=300u64 {
        let sym = if i % 3 == 0 { "MSFT" } else { "AAPL" };
        db.insert_trade(trade(i, 1_000 + i / 2, sym)).unwrap();
        if i == 100 || i == 200 {
            db.flush().unwrap();
        }
    }
    assert_eq!(db.table_count(), 2);

    let all = db.range(0, u64::MAX, None).unwrap();
    assert_eq!(all.len(), 300);
    assert!(all
        .windows(2)
        .all(|w| (w[0].timestamp_ms, w[0].trade_id) <= (w[1].timestamp_ms, w[1].trade_id)));

    // start is inclusive, end is exclusive
    let r = db.range(1_010, 1_020, None).unwrap();
    assert!(r
        .iter()
        .all(|t| t.timestamp_ms >= 1_010 && t.timestamp_ms < 1_020));
    assert_eq!(r.len(), 20);

    let msft = db.range(0, u64::MAX, Some("MSFT")).unwrap();
    assert_eq!(msft.len(), 100);
    assert!(msft.iter().all(|t| t.symbol == "MSFT"));
    assert!(db.range(5_000, 6_000, None).unwrap().is_empty());
    assert!(db.range(1_050, 1_050, None).unwrap().is_empty());
}

#[test]
fn replaced_trade_appears_once_at_its_new_time() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Database::open(dir.path()).unwrap();
    db.insert_trade(trade(1, 100, "AAPL")).unwrap();
    db.insert_trade(trade(2, 200, "AAPL")).unwrap();
    db.flush().unwrap();
    db.insert_trade(trade(1, 300, "AAPL")).unwrap(); // moved from 100 to 300
    assert!(db.range(0, 150, None).unwrap().is_empty());
    let r = db.range(0, 1_000, None).unwrap();
    assert_eq!(
        r.iter()
            .map(|t| (t.trade_id, t.timestamp_ms))
            .collect::<Vec<_>>(),
        vec![(2, 200), (1, 300)]
    );
    db.flush().unwrap();
    assert!(db.range(0, 150, None).unwrap().is_empty());
    assert_eq!(db.count(), 2);
}

#[test]
fn compaction_merges_similar_tables() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Database::open(dir.path()).unwrap();
    for round in 0..3u64 {
        for i in 1..=100u64 {
            let id = round * 100 + i;
            db.insert_trade(trade(id, 1_000 + id, "AAPL")).unwrap();
        }
        db.flush().unwrap();
    }
    // a fourth table of the same size that updates trades 1..=100
    let mut changed = trade(5, 1_005, "AAPL");
    changed.quantity = 777;
    for i in 1..=100u64 {
        let mut t = trade(i, 1_000 + i, "AAPL");
        t.quantity = 777;
        db.insert_trade(t).unwrap();
    }
    db.flush().unwrap();
    assert_eq!(db.table_count(), 4);
    let before = db.range(0, u64::MAX, None).unwrap();

    assert_eq!(db.compact().unwrap(), 4);
    assert_eq!(db.table_count(), 1);
    assert_eq!(sst_files(dir.path()), vec!["sst-4.tfs"]);
    assert_eq!(db.count(), 300);
    assert_eq!(db.range(0, u64::MAX, None).unwrap(), before);
    assert_eq!(db.get_trade(5).unwrap().unwrap(), changed);

    assert_eq!(db.compact().unwrap(), 0); // nothing left to merge
    drop(db);
    let db = Database::open(dir.path()).unwrap();
    assert_eq!(db.count(), 300);
    assert_eq!(db.get_trade(5).unwrap().unwrap(), changed);
}

#[test]
fn compaction_leaves_tables_of_very_different_size_alone() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Database::open(dir.path()).unwrap();
    db.insert_trade(trade(1, 100, "AAPL")).unwrap();
    db.flush().unwrap(); // one trade
    for i in 2..=500u64 {
        db.insert_trade(trade(i, 100 + i, "AAPL")).unwrap();
    }
    db.flush().unwrap(); // 499 trades
    assert_eq!(db.compact().unwrap(), 0);
    assert_eq!(db.table_count(), 2);
}

#[test]
fn newer_copy_wins_when_only_some_tables_are_merged() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Database::open(dir.path()).unwrap();
    // table 1: small, holds trade 1 (old copy)
    db.insert_trade(trade(1, 100, "AAPL")).unwrap();
    db.flush().unwrap();
    // table 2: big, holds the new copy of trade 1
    let mut new_copy = trade(1, 100, "AAPL");
    new_copy.quantity = 555;
    db.insert_trade(new_copy.clone()).unwrap();
    for i in 2..=400u64 {
        db.insert_trade(trade(i, 100 + i, "AAPL")).unwrap();
    }
    db.flush().unwrap();
    // tables 3 and 4: small, similar to each other
    db.insert_trade(trade(1000, 5_000, "AAPL")).unwrap();
    db.flush().unwrap();
    db.insert_trade(trade(1001, 5_001, "AAPL")).unwrap();
    db.flush().unwrap();

    assert_eq!(db.compact().unwrap(), 2); // only the two small neighbours
    assert_eq!(db.table_count(), 3);
    assert_eq!(db.get_trade(1).unwrap().unwrap(), new_copy);
}

#[test]
fn damaged_sstable_is_refused_on_open() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut db = Database::open(dir.path()).unwrap();
        for i in 1..=50 {
            db.insert_trade(trade(i, 1_000 + i, "AAPL")).unwrap();
        }
        db.flush().unwrap();
    }
    let path = dir.path().join("sst-1.tfs");
    let mut bytes = fs::read(&path).unwrap();
    bytes[10] ^= 0xff;
    fs::write(&path, bytes).unwrap();
    assert!(Database::open(dir.path()).is_err());
}

#[test]
fn leftover_temp_file_is_ignored() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut db = Database::open(dir.path()).unwrap();
        db.insert_trade(trade(1, 100, "AAPL")).unwrap();
        db.flush().unwrap();
    }
    fs::write(dir.path().join("sst-2.tfs.tmp"), b"half a file").unwrap();
    let db = Database::open(dir.path()).unwrap();
    assert_eq!(db.count(), 1);
    assert!(!dir.path().join("sst-2.tfs.tmp").exists());
}

#[test]
fn memtable_flushes_by_itself() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Database::open(dir.path()).unwrap();
    for i in 1..=25_000u64 {
        db.insert_trade(trade(i, 1_000 + i, "AAPL")).unwrap();
    }
    assert!(db.table_count() >= 2);
    assert_eq!(db.count(), 25_000);
    assert_eq!(
        db.get_trade(12_345).unwrap().unwrap(),
        trade(12_345, 13_345, "AAPL")
    );
}
