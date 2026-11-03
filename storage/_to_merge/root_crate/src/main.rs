// TickForge DB — Complete Live Demo
//
// Phase A: Basic insert, validation, MemTable lookup
// Phase B: SSTable flush + read path
// Phase C: Restart recovery (WAL + MANIFEST)
// Phase D: Query Engine (symbol, time-range, latest, paginate)
// Phase E: Tombstone delete + compaction
// Phase F: Trading Exchange (matching engine → trades → DB)

use tickforge_db::database::Database;
use tickforge_db::exchange::MatchingEngine;
use tickforge_db::record::TradeRecord;

fn sep(label: &str) {
    println!("\n══════════════════════════════════════════════════");
    println!("  {label}");
    println!("══════════════════════════════════════════════════");
}

fn trade(id: u64, sym: &str, price: u64, qty: u64, ts: u64) -> TradeRecord {
    TradeRecord { trade_id: id, symbol: sym.to_string(), price_paise: price, quantity: qty, timestamp: ts, seq_num: 0, deleted: false }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("╔══════════════════════════════════════════════════╗");
    println!("║        TickForge DB — Full Feature Demo          ║");
    println!("╚══════════════════════════════════════════════════╝");

    let wal = "data/wal.log";
    let _ = std::fs::remove_dir_all("data"); // fresh start

    // ════ Phase A: Basic Operations ══════════════════════════════════════
    sep("Phase A: Insert + Validation + Lookup");
    {
        let mut db = Database::open(wal)?;

        let ok_trades = vec![
            trade(1001, "TCS",      350_000, 10, 1_700_000_001),
            trade(1002, "INFY",     145_000, 25, 1_700_000_002),
            trade(1003, "RELIANCE", 240_000,  5, 1_700_000_003),
            trade(1004, "TCS",      351_000,  8, 1_700_000_004),
            trade(1005, "WIPRO",     52_000, 50, 1_700_000_005),
        ];
        for t in &ok_trades {
            match db.insert_trade(t.clone()) {
                Ok(())  => println!("  ✔ Trade {:4} ({:8}) @ ₹{:.2}", t.trade_id, t.symbol, t.price_paise as f64 / 100.0),
                Err(e)  => println!("  ✘ Rejected: {e}"),
            }
        }

        // Validation — zero price
        let bad = trade(9999, "BAD", 0, 1, 1);
        match db.insert_trade(bad) {
            Err(e)  => println!("\n  ✔ Zero-price rejected: {e}"),
            Ok(())  => println!("  ✘ Should have been rejected!"),
        }

        // Validation — zero quantity
        let bad2 = trade(9998, "BAD2", 100_000, 0, 1);
        match db.insert_trade(bad2) {
            Err(e)  => println!("  ✔ Zero-qty rejected: {e}"),
            Ok(())  => println!("  ✘ Should have been rejected!"),
        }

        // MemTable lookup
        let t = db.get_trade(1002).unwrap();
        println!("\n  ✔ MemTable lookup: trade 1002 = {} ₹{:.2}", t.symbol, t.price_paise as f64 / 100.0);
        println!("  MemTable size: {} records, {} bytes",
            db.memtable_len(), db.memtable_size_bytes());
    }

    // ════ Phase B: Flush → SSTable ════════════════════════════════════════
    sep("Phase B: SSTable Flush + Read Path");
    {
        let mut db = Database::open(wal)?;
        println!("  WAL replay: {} records restored", db.memtable_len());
        db.flush_to_sstable()?;
        println!("  ✔ Flushed. MemTable: {}, SSTables: {}", db.memtable_len(), db.sstable_count());

        // Bloom filter should let us skip non-existent keys
        println!("  ✔ trade 1003 (SSTable): {:?}", db.get_trade(1003).map(|t| t.symbol));
        println!("  ✔ trade 9999 (absent):  {:?}", db.get_trade(9999));

        // Insert after flush
        db.insert_trade(trade(1006, "HDFC", 165_000, 15, 1_700_000_006))?;
        println!("  ✔ Post-flush insert: trade 1006 in MemTable");
    }

    // ════ Phase C: Restart Recovery ══════════════════════════════════════
    sep("Phase C: Crash Recovery (WAL + MANIFEST)");
    {
        let db = Database::open(wal)?;
        println!("  ✔ Restart. MemTable: {}, SSTables: {}, Levels: {:?}",
            db.memtable_len(), db.sstable_count(), db.level_sizes());
        println!("  trade 1001 (SSTable): {:?}", db.get_trade(1001).map(|t| t.symbol));
        println!("  trade 1006 (WAL):     {:?}", db.get_trade(1006).map(|t| t.symbol));
    }

    // ════ Phase D: Query Engine ══════════════════════════════════════════
    sep("Phase D: Query Engine");
    {
        let mut db = Database::open(wal)?;
        db.flush_to_sstable()?;

        // Add more data
        for i in 1007u64..=1015 {
            let sym = ["TCS", "INFY", "WIPRO"][(i as usize) % 3];
            db.insert_trade(trade(i, sym, 100_000 + i * 500, i % 10 + 1, 1_700_000_000 + i))?;
        }

        // by_symbol
        let r = db.query().by_symbol("TCS")?;
        println!("  TCS trades: {} (files scanned: {})", r.trades.len(), r.files_scanned);

        // by_time_range
        let r = db.query().by_time_range(1_700_000_001, 1_700_000_005)?;
        println!("  Time-range [001..005]: {} trades", r.trades.len());

        // symbol + time-range
        let r = db.query().by_symbol_and_time_range("TCS", 1_700_000_001, 1_700_000_015)?;
        println!("  TCS in time [001..015]: {} trades", r.trades.len());

        // latest N
        let r = db.query().latest(3)?;
        let ids: Vec<u64> = r.trades.iter().map(|t| t.trade_id).collect();
        println!("  Latest 3: {:?}", ids);

        // paginate
        let p0 = db.query().paginate(0, 5)?;
        println!("  Page 0 (size 5): {} trades, total={}", p0.trades.len(), p0.total_before_page);
        let p1 = db.query().paginate(1, 5)?;
        println!("  Page 1 (size 5): {} trades", p1.trades.len());
    }

    // ════ Phase E: Delete + Compaction ═══════════════════════════════════
    sep("Phase E: Tombstone Delete + LSM Compaction");
    {
        let mut db = Database::open(wal)?;

        println!("  Before delete: trade 1001 = {:?}", db.get_trade(1001).map(|t| t.symbol));
        db.delete_trade(1001)?;
        println!("  After delete:  trade 1001 = {:?}", db.get_trade(1001));

        // Flush tombstone + trigger compaction
        db.flush_to_sstable()?;
        println!("  SSTables: {}, Levels: {:?}", db.sstable_count(), db.level_sizes());

        // Force more flushes to hit L0 threshold → auto-compact
        for i in 2000u64..2010 {
            db.insert_trade(trade(i, "X", 100_000, 1, 1_700_100_000 + i))?;
            if i % 3 == 2 { db.flush_to_sstable()?; }
        }
        db.flush_to_sstable()?;
        println!("  Post-compact Levels: {:?}", db.level_sizes());
        println!("  Trade 1001 after compact: {:?}", db.get_trade(1001));
    }

    // ════ Phase F: Matching Engine ═══════════════════════════════════════
    sep("Phase F: Trading Exchange (Order Matching → DB)");
    {
        let mut db     = Database::open(wal)?;
        let mut engine = MatchingEngine::new();
        let ts         = 1_700_200_000u64;

        println!("  [WIPRO] Seeding order book...");
        engine.limit_sell("WIPRO", 53_000, 20, ts)?;
        engine.limit_sell("WIPRO", 54_000, 10, ts + 1)?;
        println!("  Best ask: ₹{:.2}", engine.best_ask("WIPRO").unwrap_or(0) as f64 / 100.0);
        println!("  Spread:   {} paise", engine.spread("WIPRO").unwrap_or(0));

        // Limit buy → partial match
        let trades = engine.limit_buy("WIPRO", 53_500, 15, ts + 2)?;
        println!("\n  Limit buy 15@₹535.00 → {} trade(s)", trades.len());
        for t in &trades {
            println!("    ✔ {} @ ₹{:.2}  qty={}", t.symbol, t.price_paise as f64 / 100.0, t.quantity);
            db.insert_trade(t.clone())?;
        }

        // Market sell → matches remaining bid
        let trades = engine.market_sell("WIPRO", 3, ts + 3)?;
        println!("\n  Market sell 3 → {} trade(s)", trades.len());
        for t in &trades {
            println!("    ✔ {} @ ₹{:.2}  qty={}", t.symbol, t.price_paise as f64 / 100.0, t.quantity);
            db.insert_trade(t.clone())?;
        }

        println!("\n  Open orders in book: {}", engine.open_orders("WIPRO"));

        // Query from DB
        let r = db.query().by_symbol("WIPRO")?;
        println!("  WIPRO trades persisted in DB: {}", r.trades.len());
        for t in &r.trades {
            println!("    trade_id={} qty={} @ ₹{:.2}", t.trade_id, t.quantity, t.price_paise as f64 / 100.0);
        }
    }

    println!("\n╔══════════════════════════════════════════════════╗");
    println!("║  ✅ TickForge DB — All phases complete!          ║");
    println!("╚══════════════════════════════════════════════════╝\n");
    Ok(())
}
