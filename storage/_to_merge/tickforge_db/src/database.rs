//iska kaam alag components ko ek flow mein connect karna hai
use crate::memtable::MemTable;
use crate::record::TradeRecord;
use crate::triggers;
use crate::wal::Wal;

pub struct Database {
    wal: Wal,
    memtable: MemTable,
}

impl Database {
    pub fn open(wal_path: &str) -> std::io::Result<Self> {
        let wal = Wal::open(wal_path)?;
        let recovered_trades = wal.replay()?;
        let mut memtable = MemTable::new();

        for trade in recovered_trades {
            memtable.insert(trade);
        }

        println!(
            "Recovery: {} trade records loaded into MemTable",
            memtable.len()
        );
        Ok(Self { wal, memtable })
    }

    pub fn insert_trade(&mut self, trade: TradeRecord) -> Result<(), String> {
        triggers::before_insert(&trade)?;
        self.wal
            .append(&trade)
            .map_err(|e| format!("WAL write failed: {e}"))?;
        self.memtable.insert(trade.clone());
        triggers::after_insert(&trade);
        Ok(())
    }

    pub fn get_trade(&self, trade_id: u64) -> Option<&TradeRecord> {
        self.memtable.get(trade_id)
    }

    pub fn memtable_len(&self) -> usize {
        self.memtable.len()
    }

    pub fn flush_memtable(&self, path: &str) -> std::io::Result<()> {
        let trades = self.memtable.snapshot();
        crate::sstable::write_sstable(path, &trades)
    }
}
