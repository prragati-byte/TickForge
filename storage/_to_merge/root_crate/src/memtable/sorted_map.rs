// SortedMap — MemTable ke andar ka in-memory storage.
//
// Implementation: std::collections::BTreeMap
//   BTreeMap keys ko hamesha sorted order mein rakhta hai (O(log n) insert/get).
//   Yahi property SSTable flush ke liye zaroori hai — sorted output seedha milta hai.
//
// Note on naming: Original file ka naam "SkipList" tha, lekin andar BTreeMap tha.
//   SkipList ek alag data structure hai (probabilistic, linked layers).
//   Honest naam: SortedMap. Agar future mein real SkipList chahiye to yahan swap karo.

use crate::record::TradeRecord;
use std::collections::BTreeMap;

pub struct SortedMap {
    records: BTreeMap<u64, TradeRecord>,
    /// Approximate memory usage — har TradeRecord ki estimated size track karte hain
    /// taaki MemTable flush threshold decide ho sake.
    size_bytes: usize,
}

impl SortedMap {
    pub fn new() -> Self {
        Self {
            records: BTreeMap::new(),
            size_bytes: 0,
        }
    }

    pub fn insert(&mut self, trade: TradeRecord) {
        // Agar same trade_id dobara aaya to purana size minus karo
        if let Some(old) = self.records.get(&trade.trade_id) {
            self.size_bytes = self.size_bytes.saturating_sub(record_size(old));
        }
        self.size_bytes += record_size(&trade);
        self.records.insert(trade.trade_id, trade);
    }

    pub fn get(&self, trade_id: u64) -> Option<&TradeRecord> {
        self.records.get(&trade_id)
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Sorted order mein saare records ki cloned copy return karo.
    /// SSTable writer directly yeh use karta hai.
    pub fn snapshot(&self) -> Vec<TradeRecord> {
        self.records.values().cloned().collect()
    }

    /// Approximate memory bytes in use (header + string fields estimated).
    pub fn size_bytes(&self) -> usize {
        self.size_bytes
    }

    /// Saare records clear karo (flush ke baad call karo).
    pub fn clear(&mut self) {
        self.records.clear();
        self.size_bytes = 0;
    }
}

/// Ek TradeRecord ka estimated heap size (exact nahi, kafi hai threshold ke liye).
fn record_size(t: &TradeRecord) -> usize {
    // u64 fields: 5 × 8 = 40 bytes
    // String (symbol): allocation + content
    40 + t.symbol.len()
}
