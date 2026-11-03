// MemTable — WAL se recover hua ya naya insert hua data yahan in-memory rehta hai.
//
// Flush threshold: FLUSH_THRESHOLD_BYTES se zyada data hone par auto-flush trigger hoti hai.
// Database::insert_trade() mein check hota hai aur SSTable likhi jaati hai.

mod sorted_map;

use crate::record::TradeRecord;

/// MemTable kitne bytes ke baad flush karni chahiye (4 MB default).
pub const FLUSH_THRESHOLD_BYTES: usize = 4 * 1024 * 1024;

pub struct MemTable {
    records: sorted_map::SortedMap,
}

impl MemTable {
    /// Khaali MemTable banao.
    pub fn new() -> Self {
        Self {
            records: sorted_map::SortedMap::new(),
        }
    }

    /// Naya trade insert karo (same trade_id → overwrite).
    pub fn insert(&mut self, trade: TradeRecord) {
        self.records.insert(trade);
    }

    /// trade_id se record dhundho — O(log n).
    pub fn get(&self, trade_id: u64) -> Option<&TradeRecord> {
        self.records.get(trade_id)
    }

    /// Kitne records hain.
    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Approximate bytes in use — flush threshold check ke liye.
    pub fn size_bytes(&self) -> usize {
        self.records.size_bytes()
    }

    /// Kya ab flush karni chahiye?
    pub fn should_flush(&self) -> bool {
        self.records.size_bytes() >= FLUSH_THRESHOLD_BYTES
    }

    /// Sorted order mein saare records ki copy (SSTable writer ke liye).
    pub fn snapshot(&self) -> Vec<TradeRecord> {
        self.records.snapshot()
    }

    /// Flush ke baad MemTable khaali karo.
    pub fn clear(&mut self) {
        self.records.clear();
    }
}
