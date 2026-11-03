//! SSTables and compaction through io_uring must give the same files and the same
//! data as the normal write path. Skipped (with a message) if this kernel or sandbox
//! has no io_uring.
#![cfg(target_os = "linux")]

use std::fs;
use std::path::Path;
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

fn available() -> bool {
    match IoBackend::Uring.check() {
        Ok(()) => true,
        Err(e) => {
            println!("skipped: io_uring is not available here: {e}");
            false
        }
    }
}

/// Both file systems matter: ext4 takes O_DIRECT, tmpfs may not.
fn each_dir(test: impl Fn(&Path)) {
    test(tempfile::tempdir().unwrap().path());
    test(tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap().path());
}

#[test]
fn same_bytes_as_the_normal_path_at_every_size() {
    if !available() {
        return;
    }
    each_dir(|dir| {
        // Around block sizes, around the 1 MiB chunk size, and well past it.
        for n in [1u64, 2, 40, 50, 51, 52, 100, 1_000, 13_000, 13_100, 40_000] {
            let trades: Vec<Trade> = (1..=n).map(trade).collect();
            let plain = dir.join(format!("plain-{n}.tfs"));
            let uring = dir.join(format!("uring-{n}.tfs"));
            SsTable::write(&plain, &trades).unwrap();
            SsTable::write_with(&uring, &trades, IoBackend::Uring).unwrap();
            assert_eq!(fs::read(&plain).unwrap(), fs::read(&uring).unwrap(), "{n} trades");
            let table = SsTable::open(&uring).unwrap();
            assert_eq!(table.len(), n);
        }
    });
}

#[test]
fn flush_compact_and_reopen() {
    if !available() {
        return;
    }
    each_dir(|dir| {
        let mut db = Database::open_with(dir, IoBackend::Uring).unwrap();
        let mut id = 1;
        for _ in 0..4 {
            for _ in 0..500 {
                db.insert_trade(trade(id)).unwrap();
                id += 1;
            }
            db.flush().unwrap();
        }
        assert!(db.compact().unwrap() >= 2);
        assert_eq!(db.count(), 2000);
        assert_eq!(db.get_trade(1234).unwrap().unwrap(), trade(1234));
        drop(db);

        // Files from one path are read back by the other, because they are the same.
        let db = Database::open(dir).unwrap();
        assert_eq!(db.count(), 2000);
        assert_eq!(db.get_trade(77).unwrap().unwrap(), trade(77));
        assert_eq!(db.range(0, u64::MAX, None).unwrap().len(), 2000);
    });
}

#[test]
fn an_unwritable_path_is_an_error() {
    if !available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("no/such/directory/x.tfs");
    assert!(SsTable::write_with(&path, &[trade(1)], IoBackend::Uring).is_err());
}
