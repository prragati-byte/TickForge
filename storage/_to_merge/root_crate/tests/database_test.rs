// TickForge DB — Integration Tests (Phase 0+1 ke sab 15 + nayi tests)
//
// Har test apna isolated tempfile::tempdir use karta hai.
// Tests concurrently run ho sakte hain — koi shared state nahi.

use tickforge_db::database::Database;
use tickforge_db::error::DbError;
use tickforge_db::record::TradeRecord;

// ── Helpers ──────────────────────────────────────────────────────────────────

fn make_trade(id: u64, symbol: &str) -> TradeRecord {
    TradeRecord {
        trade_id:    id,
        symbol:      symbol.to_string(),
        price_paise: 100_000,
        quantity:    10,
        timestamp:   1_700_000_000 + id,
        seq_num:     0,
        deleted:     false,
    }
}

fn wal_path(dir: &tempfile::TempDir) -> String {
    dir.path().join("wal.log").to_string_lossy().to_string()
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. WAL Durability
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn wal_data_survives_restart() {
    let dir  = tempfile::tempdir().unwrap();
    let path = wal_path(&dir);
    {
        let mut db = Database::open(&path).unwrap();
        db.insert_trade(make_trade(1, "TCS")).unwrap();
        db.insert_trade(make_trade(2, "INFY")).unwrap();
    }
    let db = Database::open(&path).unwrap();
    assert!(db.get_trade(1).is_some());
    assert!(db.get_trade(2).is_some());
    assert_eq!(db.memtable_len(), 2);
}

#[test]
fn torn_wal_tail_does_not_break_open() {
    let dir  = tempfile::tempdir().unwrap();
    let path = wal_path(&dir);
    {
        let mut db = Database::open(&path).unwrap();
        db.insert_trade(make_trade(10, "RELIANCE")).unwrap();
    }
    // Append random garbage (torn write simulation)
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"\xDE\xAD\xBE\xEF\x00\x00\x00\x00garbage").unwrap();
    }
    let db = Database::open(&path).unwrap();
    assert!(db.get_trade(10).is_some(), "Valid record must survive torn tail");
    assert_eq!(db.memtable_len(), 1);
}

#[test]
fn crc_corrupt_record_stops_at_boundary() {
    let dir  = tempfile::tempdir().unwrap();
    let path = wal_path(&dir);
    {
        let mut db = Database::open(&path).unwrap();
        db.insert_trade(make_trade(20, "HDFC")).unwrap();
    }
    // Flip a bit in CRC field (bytes 4-7 of record)
    let mut data = std::fs::read(&path).unwrap();
    if data.len() > 8 { data[5] ^= 0xFF; }
    std::fs::write(&path, &data).unwrap();

    let db = Database::open(&path).unwrap();
    // Corrupt record should be dropped
    assert!(db.get_trade(20).is_none());
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Validation
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn zero_price_rejected() {
    let dir  = tempfile::tempdir().unwrap();
    let mut db = Database::open(&wal_path(&dir)).unwrap();
    let bad = TradeRecord { trade_id: 99, symbol: "X".into(), price_paise: 0, quantity: 1, timestamp: 1, seq_num: 0, deleted: false };
    assert!(matches!(db.insert_trade(bad), Err(DbError::Validation(_))));
}

#[test]
fn zero_quantity_rejected() {
    let dir  = tempfile::tempdir().unwrap();
    let mut db = Database::open(&wal_path(&dir)).unwrap();
    let bad = TradeRecord { trade_id: 100, symbol: "TCS".into(), price_paise: 100_000, quantity: 0, timestamp: 1, seq_num: 0, deleted: false };
    assert!(matches!(db.insert_trade(bad), Err(DbError::Validation(_))));
}

#[test]
fn empty_symbol_rejected() {
    let dir  = tempfile::tempdir().unwrap();
    let mut db = Database::open(&wal_path(&dir)).unwrap();
    let bad = TradeRecord { trade_id: 101, symbol: "   ".into(), price_paise: 100_000, quantity: 5, timestamp: 1, seq_num: 0, deleted: false };
    assert!(matches!(db.insert_trade(bad), Err(DbError::Validation(_))));
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. SSTable Read Path
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn data_readable_after_flush() {
    let dir  = tempfile::tempdir().unwrap();
    let mut db = Database::open(&wal_path(&dir)).unwrap();
    db.insert_trade(make_trade(200, "WIPRO")).unwrap();
    db.insert_trade(make_trade(201, "TCS")).unwrap();
    db.flush_to_sstable().unwrap();
    assert_eq!(db.memtable_len(), 0);
    assert!(db.get_trade(200).is_some());
    assert!(db.get_trade(201).is_some());
}

#[test]
fn sstable_survives_restart() {
    let dir  = tempfile::tempdir().unwrap();
    let path = wal_path(&dir);
    {
        let mut db = Database::open(&path).unwrap();
        db.insert_trade(make_trade(300, "INFY")).unwrap();
        db.flush_to_sstable().unwrap();
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(db.memtable_len(), 0);
    assert_eq!(db.sstable_count(), 1);
    assert!(db.get_trade(300).is_some());
}

#[test]
fn read_path_checks_memtable_then_sstable() {
    let dir  = tempfile::tempdir().unwrap();
    let mut db = Database::open(&wal_path(&dir)).unwrap();
    db.insert_trade(make_trade(400, "A")).unwrap();
    db.flush_to_sstable().unwrap();  // → SSTable
    db.insert_trade(make_trade(401, "B")).unwrap(); // → MemTable
    assert!(db.get_trade(400).is_some());
    assert!(db.get_trade(401).is_some());
    assert!(db.get_trade(999).is_none());
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. SSTable Writer/Reader Unit Tests
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn sstable_write_and_read_roundtrip() {
    let dir   = tempfile::tempdir().unwrap();
    let path  = dir.path().join("t.sst").to_string_lossy().to_string();
    let trades = vec![make_trade(1, "TCS"), make_trade(2, "INFY"), make_trade(3, "WIPRO")];
    tickforge_db::sstable::write_sstable(&path, &trades).unwrap();
    let back  = tickforge_db::sstable::read_all_trades(&path).unwrap();
    assert_eq!(back.len(), 3);
    assert_eq!(back[2].symbol, "WIPRO");
}

#[test]
fn sstable_metadata_correct() {
    let dir   = tempfile::tempdir().unwrap();
    let path  = dir.path().join("m.sst").to_string_lossy().to_string();
    let trades = vec![make_trade(10, "A"), make_trade(20, "B"), make_trade(30, "C")];
    tickforge_db::sstable::write_sstable(&path, &trades).unwrap();
    let meta  = tickforge_db::sstable::read_metadata(&path).unwrap();
    assert_eq!(meta.min_key, 10);
    assert_eq!(meta.max_key, 30);
    assert_eq!(meta.count, 3);
    assert!(meta.might_contain(20));
    assert!(!meta.might_contain(5));
    assert!(!meta.might_contain(100));
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. TriggerRegistry
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn custom_before_trigger_can_reject() {
    let dir  = tempfile::tempdir().unwrap();
    let mut db = Database::open(&wal_path(&dir)).unwrap();
    db.triggers.register_before(|t| {
        if t.symbol == "BANNED" {
            Err(DbError::Validation("symbol banned".to_string()))
        } else { Ok(()) }
    });
    let bad = TradeRecord { trade_id: 500, symbol: "BANNED".into(), price_paise: 100_000, quantity: 1, timestamp: 1, seq_num: 0, deleted: false };
    assert!(matches!(db.insert_trade(bad), Err(DbError::Validation(_))));
    db.insert_trade(make_trade(501, "OK")).unwrap();
    assert!(db.get_trade(501).is_some());
}

#[test]
fn custom_after_trigger_fires() {
    use std::sync::{Arc, Mutex};
    let dir  = tempfile::tempdir().unwrap();
    let mut db = Database::open(&wal_path(&dir)).unwrap();
    let cnt  = Arc::new(Mutex::new(0u32));
    let c    = Arc::clone(&cnt);
    db.triggers.register_after(move |_| { *c.lock().unwrap() += 1; });
    db.insert_trade(make_trade(600, "X")).unwrap();
    db.insert_trade(make_trade(601, "Y")).unwrap();
    assert_eq!(*cnt.lock().unwrap(), 2);
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. WAL Truncate After Flush
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn wal_truncated_after_flush() {
    let dir  = tempfile::tempdir().unwrap();
    let path = wal_path(&dir);
    {
        let mut db = Database::open(&path).unwrap();
        db.insert_trade(make_trade(700, "TCS")).unwrap();
        db.flush_to_sstable().unwrap();
    }
    let sz = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(999);
    assert_eq!(sz, 0, "WAL must be 0 bytes after flush");
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Duplicate Trade ID
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn duplicate_trade_id_overwrites() {
    let dir  = tempfile::tempdir().unwrap();
    let mut db = Database::open(&wal_path(&dir)).unwrap();
    let t1 = TradeRecord { trade_id: 800, symbol: "OLD".into(), price_paise: 100_000, quantity: 5, timestamp: 1, seq_num: 0, deleted: false };
    let t2 = TradeRecord { trade_id: 800, symbol: "NEW".into(), price_paise: 200_000, quantity: 10, timestamp: 2, seq_num: 0, deleted: false };
    db.insert_trade(t1).unwrap();
    db.insert_trade(t2).unwrap();
    let found = db.get_trade(800).unwrap();
    assert_eq!(found.symbol, "NEW");
    assert_eq!(found.price_paise, 200_000);
}

#[test]
fn reject_duplicate_ids_mode() {
    let dir  = tempfile::tempdir().unwrap();
    let mut db = Database::open(&wal_path(&dir)).unwrap();
    db.reject_duplicate_ids = true;
    db.insert_trade(make_trade(900, "TCS")).unwrap();
    let dup = make_trade(900, "TCS");
    assert!(matches!(db.insert_trade(dup), Err(DbError::Validation(_))));
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Tombstone / Delete
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn delete_trade_hides_record() {
    let dir  = tempfile::tempdir().unwrap();
    let mut db = Database::open(&wal_path(&dir)).unwrap();
    db.insert_trade(make_trade(1000, "TCS")).unwrap();
    assert!(db.get_trade(1000).is_some(), "Should exist before delete");
    db.delete_trade(1000).unwrap();
    assert!(db.get_trade(1000).is_none(), "Should be gone after delete");
}

#[test]
fn tombstone_survives_restart_and_hides_sstable_record() {
    let dir  = tempfile::tempdir().unwrap();
    let path = wal_path(&dir);
    {
        let mut db = Database::open(&path).unwrap();
        db.insert_trade(make_trade(1100, "INFY")).unwrap();
        db.flush_to_sstable().unwrap(); // trade → SSTable
        db.delete_trade(1100).unwrap(); // tombstone → WAL + MemTable
    }
    // Restart: trade in SSTable, tombstone in WAL
    let db = Database::open(&path).unwrap();
    assert!(db.get_trade(1100).is_none(), "Tombstone must hide SSTable record after restart");
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. Query Engine
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn query_by_symbol() {
    let dir  = tempfile::tempdir().unwrap();
    let mut db = Database::open(&wal_path(&dir)).unwrap();
    db.insert_trade(make_trade(2001, "TCS")).unwrap();
    db.insert_trade(make_trade(2002, "INFY")).unwrap();
    db.insert_trade(make_trade(2003, "TCS")).unwrap();
    let r = db.query().by_symbol("TCS").unwrap();
    assert_eq!(r.trades.len(), 2, "Exactly 2 TCS trades");
    assert!(r.trades.iter().all(|t| t.symbol == "TCS"));
}

#[test]
fn query_by_time_range() {
    let dir  = tempfile::tempdir().unwrap();
    let mut db = Database::open(&wal_path(&dir)).unwrap();
    for i in 1..=5u64 {
        db.insert_trade(TradeRecord {
            trade_id: 3000 + i, symbol: "X".into(),
            price_paise: 100_000, quantity: 1,
            timestamp: 1_700_000_000 + i,
            seq_num: 0, deleted: false,
        }).unwrap();
    }
    let r = db.query().by_time_range(1_700_000_002, 1_700_000_004).unwrap();
    assert_eq!(r.trades.len(), 3, "Trades at ts 2,3,4 only");
}

#[test]
fn query_latest_n() {
    let dir  = tempfile::tempdir().unwrap();
    let mut db = Database::open(&wal_path(&dir)).unwrap();
    for i in 1..=5u64 {
        db.insert_trade(TradeRecord {
            trade_id: 4000 + i, symbol: "Y".into(),
            price_paise: 100_000, quantity: 1,
            timestamp: 1_700_000_000 + i,
            seq_num: 0, deleted: false,
        }).unwrap();
    }
    let r = db.query().latest(3).unwrap();
    assert_eq!(r.trades.len(), 3);
    // Should be sorted by timestamp DESC
    assert!(r.trades[0].timestamp >= r.trades[1].timestamp);
}

#[test]
fn query_paginate() {
    let dir  = tempfile::tempdir().unwrap();
    let mut db = Database::open(&wal_path(&dir)).unwrap();
    for i in 1..=10u64 {
        db.insert_trade(make_trade(5000 + i, "Z")).unwrap();
    }
    let p0 = db.query().paginate(0, 4).unwrap();
    let p1 = db.query().paginate(1, 4).unwrap();
    let p2 = db.query().paginate(2, 4).unwrap();
    assert_eq!(p0.trades.len(), 4);
    assert_eq!(p1.trades.len(), 4);
    assert_eq!(p2.trades.len(), 2);   // 10 total, page 2 has 2 left
    assert_eq!(p0.total_before_page, 10);
}

#[test]
fn query_across_memtable_and_sstable() {
    let dir  = tempfile::tempdir().unwrap();
    let mut db = Database::open(&wal_path(&dir)).unwrap();
    db.insert_trade(make_trade(6001, "TCS")).unwrap();
    db.flush_to_sstable().unwrap();  // → SSTable
    db.insert_trade(make_trade(6002, "TCS")).unwrap(); // → MemTable
    let r = db.query().by_symbol("TCS").unwrap();
    assert_eq!(r.trades.len(), 2, "Must find trades from both MemTable and SSTable");
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. Bloom Filter Unit Tests
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn bloom_no_false_negatives() {
    use tickforge_db::bloom::BloomFilter;
    let mut bf = BloomFilter::with_capacity(100);
    for id in 1..=100u64 { bf.insert(id); }
    for id in 1..=100u64 {
        assert!(bf.might_contain(id), "No false negatives allowed: id {id}");
    }
}

#[test]
fn bloom_false_positive_rate_acceptable() {
    use tickforge_db::bloom::BloomFilter;
    let mut bf = BloomFilter::with_capacity(500);
    for id in 1..=500u64 { bf.insert(id); }
    let fp: usize = (1000..2000u64).filter(|&id| bf.might_contain(id)).count();
    assert!(fp < 50, "FPR too high: {fp}/1000 (expected <5%)");
}
