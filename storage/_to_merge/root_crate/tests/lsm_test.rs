// LSM-Tree Architecture Tests
//
// Covers:
//   - Compaction correctness (merge_records unit tests mein bhi hain)
//   - L0 → L1 auto-compaction trigger
//   - Post-compaction data integrity
//   - Tombstone compaction at bottom level
//   - MANIFEST recovery after compaction
//   - Multiple SSTable levels mein read path

use tickforge_db::database::Database;
use tickforge_db::record::TradeRecord;

fn wal_path(dir: &tempfile::TempDir) -> String {
    dir.path().join("wal.log").to_string_lossy().to_string()
}

fn trade(id: u64, sym: &str) -> TradeRecord {
    TradeRecord {
        trade_id:    id,
        symbol:      sym.to_string(),
        price_paise: 100_000,
        quantity:    10,
        timestamp:   1_700_000_000 + id,
        seq_num:     0,
        deleted:     false,
    }
}

// ── Compaction merge logic (unit level) ──────────────────────────────────────

#[test]
fn compaction_merge_dedup() {
    use tickforge_db::lsm::compaction::merge_records;
    use tickforge_db::record::TradeRecord;

    let records = vec![
        TradeRecord { trade_id: 1, symbol: "A".into(), price_paise: 100, quantity: 1, timestamp: 1, seq_num: 1, deleted: false },
        TradeRecord { trade_id: 1, symbol: "B".into(), price_paise: 200, quantity: 1, timestamp: 2, seq_num: 3, deleted: false },
        TradeRecord { trade_id: 1, symbol: "C".into(), price_paise: 300, quantity: 1, timestamp: 3, seq_num: 2, deleted: false },
        TradeRecord { trade_id: 2, symbol: "X".into(), price_paise: 100, quantity: 1, timestamp: 1, seq_num: 1, deleted: false },
    ];
    let merged = merge_records(records, false);
    assert_eq!(merged.len(), 2);
    // trade_id=1: seq_num=3 wins (symbol "B")
    assert_eq!(merged.iter().find(|t| t.trade_id == 1).unwrap().symbol, "B");
}

#[test]
fn compaction_tombstone_removed_at_bottom_level() {
    use tickforge_db::lsm::compaction::merge_records;
    use tickforge_db::record::TradeRecord;

    let records = vec![
        TradeRecord { trade_id: 5, symbol: "".into(), price_paise: 0, quantity: 0, timestamp: 0, seq_num: 2, deleted: true },
        TradeRecord { trade_id: 5, symbol: "X".into(), price_paise: 100, quantity: 1, timestamp: 1, seq_num: 1, deleted: false },
    ];
    // Bottom level → tombstone drop karo
    let merged = merge_records(records, true);
    assert!(merged.is_empty(), "Tombstone should erase the old record at bottom level");
}

// ── Integration: auto-compaction trigger ────────────────────────────────────

#[test]
fn auto_compaction_fires_at_l0_threshold() {
    let dir  = tempfile::tempdir().unwrap();
    let path = wal_path(&dir);
    let mut db = Database::open(&path).unwrap();

    // L0 threshold = 4; insert + flush 4 times → auto-compact on 4th flush
    for batch in 0..4u64 {
        for j in 0..3u64 {
            db.insert_trade(trade(batch * 100 + j, "TCS")).unwrap();
        }
        db.flush_to_sstable().unwrap();
    }

    // Na total SSTable count L0_THRESHOLD se zyada hona chahiye
    // (auto-compact ne L0 → L1 kar diya)
    let levels = db.level_sizes();
    let l0_count = levels.get(0).copied().unwrap_or(0);
    assert!(l0_count < tickforge_db::lsm::L0_COMPACT_THRESHOLD,
        "L0 should be compacted: l0={l0_count}");
}

#[test]
fn data_survives_compaction() {
    let dir  = tempfile::tempdir().unwrap();
    let path = wal_path(&dir);
    let mut db = Database::open(&path).unwrap();

    // Insert distinctive records across multiple flushes
    let ids = [10u64, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
    for (i, &id) in ids.iter().enumerate() {
        db.insert_trade(trade(id, "TCS")).unwrap();
        if (i + 1) % 3 == 0 {
            db.flush_to_sstable().unwrap(); // flush every 3 trades
        }
    }
    db.flush_to_sstable().unwrap(); // flush remaining

    // All records must be findable after potential compaction
    for &id in &ids {
        assert!(db.get_trade(id).is_some(), "Trade {id} lost after compaction!");
    }
}

#[test]
fn tombstone_compacted_away_at_bottom_level() {
    let dir  = tempfile::tempdir().unwrap();
    let path = wal_path(&dir);
    let mut db = Database::open(&path).unwrap();

    db.insert_trade(trade(999, "DEL")).unwrap();
    db.flush_to_sstable().unwrap(); // trade → L0 SSTable

    db.delete_trade(999).unwrap();
    // Flush tombstone → L0; now we have 2 L0 files
    db.flush_to_sstable().unwrap();

    // Force more flushes to trigger compaction (threshold = 4)
    for i in 0..2u64 {
        db.insert_trade(trade(9000 + i, "X")).unwrap();
        db.flush_to_sstable().unwrap();
    }

    // After compaction, trade 999 should be gone
    assert!(db.get_trade(999).is_none(), "Deleted trade must not appear after compaction");
}

#[test]
fn compaction_manifest_recovery() {
    let dir  = tempfile::tempdir().unwrap();
    let path = wal_path(&dir);

    {
        let mut db = Database::open(&path).unwrap();
        for batch in 0..4u64 {
            for j in 0..2u64 {
                db.insert_trade(trade(batch * 10 + j + 1, "TCS")).unwrap();
            }
            db.flush_to_sstable().unwrap(); // triggers compaction on 4th
        }
        // Some data must be in L1 now
        eprintln!("Before restart: levels={:?}", db.level_sizes());
    }

    // Restart — MANIFEST must restore L1 SSTables
    let db = Database::open(&path).unwrap();
    eprintln!("After restart: levels={:?}", db.level_sizes());
    assert!(db.sstable_count() > 0, "SSTables must survive restart");

    // Data must be readable
    assert!(db.get_trade(1).is_some() || db.get_trade(2).is_some(),
        "At least some trades must survive restart after compaction");
}

// ── Multi-level read path ────────────────────────────────────────────────────

#[test]
fn read_path_newest_version_wins_across_levels() {
    let dir  = tempfile::tempdir().unwrap();
    let mut db = Database::open(&wal_path(&dir)).unwrap();

    // Old version → flush to SSTable
    db.insert_trade(TradeRecord {
        trade_id: 7777, symbol: "OLD".into(),
        price_paise: 100_000, quantity: 1,
        timestamp: 1, seq_num: 0, deleted: false,
    }).unwrap();
    db.flush_to_sstable().unwrap();

    // New version → MemTable (higher seq_num after insert)
    db.insert_trade(TradeRecord {
        trade_id: 7777, symbol: "NEW".into(),
        price_paise: 200_000, quantity: 2,
        timestamp: 2, seq_num: 0, deleted: false,
    }).unwrap();

    let found = db.get_trade(7777).unwrap();
    assert_eq!(found.symbol, "NEW", "MemTable (newest) must win over SSTable");
}
