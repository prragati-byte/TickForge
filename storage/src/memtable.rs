//! The memtable: recent trades held in memory.
//!
//! It is a `BTreeMap` keyed by trade id (a B-tree), the simple baseline.
//! A skip list would behave the same for this workload, so none is built.

use crate::record::Trade;
use std::collections::BTreeMap;

#[derive(Default)]
pub struct MemTable {
    trades: BTreeMap<u64, Trade>,
}

impl MemTable {
    /// Insert, replacing any trade with the same id.
    pub fn insert(&mut self, trade: Trade) {
        self.trades.insert(trade.trade_id, trade);
    }

    pub fn get(&self, trade_id: u64) -> Option<&Trade> {
        self.trades.get(&trade_id)
    }

    pub fn contains(&self, trade_id: u64) -> bool {
        self.trades.contains_key(&trade_id)
    }

    pub fn len(&self) -> usize {
        self.trades.len()
    }

    pub fn is_empty(&self) -> bool {
        self.trades.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Trade> {
        self.trades.values()
    }

    /// A copy of everything, sorted by (timestamp_ms, trade_id) for an SSTable.
    pub fn sorted(&self) -> Vec<Trade> {
        let mut all: Vec<Trade> = self.trades.values().cloned().collect();
        all.sort_by_key(|t| (t.timestamp_ms, t.trade_id));
        all
    }

    pub fn clear(&mut self) {
        self.trades.clear();
    }
}
