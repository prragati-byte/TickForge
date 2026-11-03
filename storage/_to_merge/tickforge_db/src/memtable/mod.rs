mod skiplist;
use crate::record::TradeRecord;
pub struct MemTable {
    records: skiplist::SkipList,
}

impl MemTable {
    pub fn new() -> Self {
        //Empty MemTable create karna
        Self {
            records: skiplist::SkipList::new(),
        }
    }

    pub fn insert(&mut self, trade: TradeRecord) {
        //Naya trade add karna
        self.records.insert(trade);
    }

    pub fn get(&self, trade_id: u64) -> Option<&TradeRecord> {
        //Trade ID se record dhoondhna
        self.records.get(trade_id)
    }

    pub fn len(&self) -> usize {
        //Records ki count
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        //Check karna ki table empty hai ya nahi
        self.records.is_empty()
    }

    pub fn snapshot(&self) -> Vec<TradeRecord> {
        //Records ki copy banana
        self.records.snapshot()
    }
}
