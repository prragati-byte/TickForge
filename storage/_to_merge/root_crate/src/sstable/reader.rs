// SSTable Reader — TF_SST_V1 format files padho.
//
// SstableMetadata (footer se load hoti hai):
//   min_key / max_key : key range pre-filter (point lookups)
//   min_ts  / max_ts  : timestamp range pre-filter (time-range queries)
//   bloom             : Bloom filter (negative lookup skip karo)
//
// Filtering order (cheapest se expensive):
//   1. Key range    → might_contain(id)         — O(1), no disk I/O
//   2. Bloom filter → bloom.might_contain(id)   — O(k), no disk I/O
//   3. Timestamp    → might_contain_ts_range()  — O(1), no disk I/O
//   4. Full scan    → read_all_trades()         — O(n), disk I/O

use std::fs::File;
use std::io::{BufRead, BufReader};

use crate::bloom::BloomFilter;
use crate::error::DbError;
use crate::record::TradeRecord;

/// Ek SSTable file ki in-memory metadata summary.
/// Startup par footer parse hoke load hoti hai.
#[derive(Debug, Clone)]
pub struct SstableMetadata {
    pub path:    String,
    pub min_key: u64,
    pub max_key: u64,
    pub min_ts:  u64,
    pub max_ts:  u64,
    pub count:   usize,
    pub bloom:   Option<BloomFilter>,
}

impl SstableMetadata {
    /// Kya `trade_id` is SSTable mein ho sakta hai?
    ///   false → definitely nahi (disk skip karo)
    ///   true  → shayad hai (file padho)
    pub fn might_contain(&self, trade_id: u64) -> bool {
        // Key range check (no disk I/O)
        if trade_id < self.min_key || trade_id > self.max_key {
            return false;
        }
        // Bloom filter check (probabilistic, no disk I/O)
        match &self.bloom {
            Some(b) => b.might_contain(trade_id),
            None    => true,
        }
    }

    /// Kya is SSTable mein [from_ts, to_ts] range ke records ho sakte hain?
    pub fn might_contain_ts_range(&self, from_ts: u64, to_ts: u64) -> bool {
        self.max_ts >= from_ts && self.min_ts <= to_ts
    }
}

// ── Core reader functions ────────────────────────────────────────────────────

/// SSTable file ke saare valid trade records padho.
/// Header (TF_SST_V1) aur footer lines automatically skip hoti hain.
pub fn read_all_trades(path: &str) -> Result<Vec<TradeRecord>, DbError> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let mut trades = Vec::new();
    let mut header_seen = false;

    for line in reader.lines() {
        let line = line?;
        let line = line.trim();

        // Header line
        if !header_seen {
            if line == "TF_SST_V1" {
                header_seen = true;
            }
            continue;
        }

        // Footer / empty lines skip karo
        if line.is_empty()
            || line.starts_with("MIN_KEY=")
            || line.starts_with("MAX_KEY=")
            || line.starts_with("MIN_TS=")
            || line.starts_with("MAX_TS=")
            || line.starts_with("COUNT=")
            || line.starts_with("BLOOM")
            || line == "END_TF_SST"
        {
            continue;
        }

        let trade: TradeRecord = serde_json::from_str(line)
            .map_err(|e| DbError::Corrupt(format!("SSTable {path} bad JSON: {e}")))?;
        trades.push(trade);
    }

    Ok(trades)
}

/// SSTable footer se metadata parse karo (bina records padhe).
pub fn read_metadata(path: &str) -> Result<SstableMetadata, DbError> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let lines: Vec<String> = reader.lines().collect::<Result<_, _>>()?;

    let mut min_key   = 0u64;
    let mut max_key   = 0u64;
    let mut min_ts    = 0u64;
    let mut max_ts    = u64::MAX; // default: no TS filtering for old-format files
    let mut count     = 0usize;
    let mut bloom_m   = 0usize;
    let mut bloom_k   = 0u32;
    let mut bloom_hex = String::new();

    // Footer ko end se parse karo (efficient)
    for line in lines.iter().rev() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("MIN_KEY=") {
            min_key = v.parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("MAX_KEY=") {
            max_key = v.parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("MIN_TS=") {
            min_ts = v.parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("MAX_TS=") {
            max_ts = v.parse().unwrap_or(u64::MAX);
        } else if let Some(v) = line.strip_prefix("COUNT=") {
            count = v.parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("BLOOM_M=") {
            bloom_m = v.parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("BLOOM_K=") {
            bloom_k = v.parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("BLOOM=") {
            bloom_hex = v.to_string();
        } else if line == "TF_SST_V1" {
            break; // header tak pahunche, done
        }
    }

    let bloom = if bloom_m > 0 && bloom_k > 0 && !bloom_hex.is_empty() {
        match BloomFilter::from_hex(&bloom_hex, bloom_k) {
            Ok(b)  => Some(b),
            Err(e) => {
                eprintln!("[SSTable] Bloom parse failed {path}: {e}");
                None
            }
        }
    } else {
        None
    };

    Ok(SstableMetadata {
        path: path.to_string(),
        min_key,
        max_key,
        min_ts,
        max_ts,
        count,
        bloom,
    })
}

/// Ek specific trade_id SSTable mein dhundho.
/// Bloom/key-range pre-filter automatically apply hota hai.
pub fn find_trade(path: &str, trade_id: u64) -> Result<Option<TradeRecord>, DbError> {
    let trades = read_all_trades(path)?;
    Ok(trades.into_iter().find(|t| t.trade_id == trade_id))
}

// ── Backward-compatibility aliases ───────────────────────────────────────────
pub fn read_sstable(path: &str) -> Result<Vec<TradeRecord>, DbError> {
    read_all_trades(path)
}
pub fn find_trade_in_sstable(path: &str, id: u64) -> Result<Option<TradeRecord>, DbError> {
    find_trade(path, id)
}
