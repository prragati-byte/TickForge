// SSTable Writer — MemTable ka sorted data disk par atomically save karta hai.
//
// Crash-safe write protocol:
//   1. {path}.tmp mein likho
//   2. BufWriter::flush()  → user-space → OS page cache
//   3. sync_all()          → OS page cache → physical disk
//   4. rename(tmp, final)  → atomic swap (POSIX guarantee)
//
// SSTable file format (TF_SST_V1):
//   Line 1:  "TF_SST_V1"                   ← magic header + version
//   Lines:   one JSON record per line       ← sorted by trade_id
//   Footer:  MIN_KEY / MAX_KEY             ← key range (point lookup filter)
//            MIN_TS  / MAX_TS              ← timestamp range (time-range filter)
//            COUNT                         ← record count
//            BLOOM_M / BLOOM_K / BLOOM     ← Bloom filter (membership test)
//            "END_TF_SST"                  ← footer sentinel
//
// Footer se reader bina records padhe pre-filter kar sakta hai:
//   - key out of [MIN_KEY, MAX_KEY] → skip
//   - bloom.might_contain(id) = false → skip
//   - timestamp range na overlap → skip time-range queries

use crate::bloom::BloomFilter;
use crate::error::DbError;
use crate::record::TradeRecord;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;

/// Sorted trades list ko ek SSTable file mein atomically likho.
/// Khaali `trades` → no-op (empty SSTable nahi banti).
pub fn write_sstable(path: &str, trades: &[TradeRecord]) -> Result<(), DbError> {
    if trades.is_empty() {
        return Ok(());
    }

    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent)?;
    }

    // Key range (trades sorted hain assume karte hain — database sort karke deta hai)
    let min_key = trades.iter().map(|t| t.trade_id).min().unwrap();
    let max_key = trades.iter().map(|t| t.trade_id).max().unwrap();

    // Timestamp range (tombstones ka timestamp 0 hota hai — normal records ke ts use karo)
    let live_trades: Vec<_> = trades.iter().filter(|t| !t.deleted).collect();
    let min_ts = live_trades.iter().map(|t| t.timestamp).min().unwrap_or(0);
    let max_ts = live_trades.iter().map(|t| t.timestamp).max().unwrap_or(u64::MAX);

    // Bloom filter — only trade_ids insert karo
    let mut bloom = BloomFilter::with_capacity(trades.len());
    for trade in trades {
        bloom.insert(trade.trade_id);
    }

    let tmp_path = format!("{path}.tmp");

    // ── Step 1: tmp file mein complete data likho ─────────────────────────
    {
        let file = File::create(&tmp_path)?;
        let mut w = BufWriter::new(file);

        writeln!(w, "TF_SST_V1")?;

        for trade in trades {
            let json = serde_json::to_string(trade)
                .map_err(|e| DbError::Corrupt(format!("Serialize error: {e}")))?;
            writeln!(w, "{json}")?;
        }

        // Footer
        writeln!(w, "MIN_KEY={min_key}")?;
        writeln!(w, "MAX_KEY={max_key}")?;
        writeln!(w, "MIN_TS={min_ts}")?;
        writeln!(w, "MAX_TS={max_ts}")?;
        writeln!(w, "COUNT={}", trades.len())?;
        writeln!(w, "BLOOM_M={}", bloom.m())?;
        writeln!(w, "BLOOM_K={}", bloom.k())?;
        writeln!(w, "BLOOM={}", bloom.to_hex())?;
        writeln!(w, "END_TF_SST")?;

        // ── Step 2: OS buffer flush ───────────────────────────────────────
        w.flush()?;
        // ── Step 3: OS → physical disk ───────────────────────────────────
        w.get_ref().sync_all()?;
    } // file close

    // ── Step 4: Atomic rename ─────────────────────────────────────────────
    fs::rename(&tmp_path, path)?;

    Ok(())
}
