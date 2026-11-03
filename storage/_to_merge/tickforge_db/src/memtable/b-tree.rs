use crate::record::TradeRecord;
use std::collections::BTreeMap;

pub struct SkipList {
    records: BTreeMap<u64, TradeRecord>,
}

impl SkipList {
    pub fn new() -> Self {
        Self {
            records: BTreeMap::new(),
        }
    }

    pub fn insert(&mut self, trade: TradeRecord) {
        self.records.insert(trade.trade_id, trade);
    }

    pub fn get(&self, trade_id: u64) -> Option<&TradeRecord> {
        //Return record
        self.records.get(&trade_id)
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn snapshot(&self) -> Vec<TradeRecord> {
        self.records.values().cloned().collect()
    }
}
