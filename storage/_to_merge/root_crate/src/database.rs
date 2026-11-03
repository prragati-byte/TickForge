// Database — TickForge DB ka central coordinator.
//
// Write path:
//   validate() → BEFORE triggers → [duplicate check] → WAL.append()
//   → MemTable.insert() → AFTER triggers → [auto-flush check]
//
// Read path (newest first):
//   MemTable → L0 SSTables (newest→oldest) → L1 SSTables → L2 ...
//
// Durability guarantees:
//   WAL: crash ke baad replay hoti hai (torn tail auto-truncated).
//   SSTable: atomic tmp→sync→rename write.
//   MANIFEST: atomic rename, flush se pehle update.
//
// Sequence numbers:
//   Har insert ko `lsm.alloc_seq()` se unique seq_num milta hai.
//   WAL recovery ke baad max seq_num restored hota hai.
//
// Public API:
//   open()          → WAL replay + MANIFEST load
//   insert_trade()  → WAL + MemTable + triggers + auto-flush
//   delete_trade()  → tombstone via WAL + MemTable
//   get_trade()     → MemTable → SSTables
//   flush_to_sstable() → manual flush
//   compact()       → manual L0→L1 compaction
//   query()         → QueryEngine (rich queries)

use std::path::Path;

use crate::error::DbError;
use crate::lsm::LsmEngine;
use crate::memtable::MemTable;
use crate::query::QueryEngine;
use crate::record::TradeRecord;
use crate::sstable::{read_metadata, write_sstable};
use crate::triggers::{validate, TriggerRegistry};
use crate::wal::Wal;

pub struct Database {
    pub(crate) wal:      Wal,
    pub(crate) memtable: MemTable,
    pub(crate) lsm:      LsmEngine,
    /// User-defined BEFORE/AFTER insert triggers.
    pub triggers: TriggerRegistry,
    /// true → same trade_id ka duplicate insert Err(Validation) deta hai.
    /// false (default) → newer version purani ko overwrite karta hai.
    pub reject_duplicate_ids: bool,
}

impl Database {
    // ── Lifecycle ────────────────────────────────────────────────────────────

    /// Database open karo (ya fresh create karo).
    /// WAL replay + MANIFEST se SSTable list restore hoti hai.
    pub fn open(wal_path: &str) -> Result<Self, DbError> {
        let data_dir = Path::new(wal_path)
            .parent()
            .unwrap_or(Path::new("."))
            .to_path_buf();

        // LSM engine (MANIFEST load karta hai)
        let mut lsm = LsmEngine::open(data_dir)?;

        // WAL open (torn tail auto-truncate hoti hai)
        let mut wal = Wal::open(wal_path)?;

        // WAL replay → MemTable mein restore karo
        let recovered    = wal.replay()?;
        let recover_count = recovered.len();
        let mut memtable = MemTable::new();

        for trade in &recovered {
            // WAL ke seq_nums se LSM ka next_seq update karo (restart safety)
            if trade.seq_num >= lsm.next_seq {
                lsm.next_seq = trade.seq_num + 1;
            }
        }
        for trade in recovered {
            memtable.insert(trade);
        }

        if recover_count > 0 {
            eprintln!("[DB] WAL se {recover_count} records restored");
        }
        if lsm.sstable_count() > 0 {
            eprintln!("[DB] {} SSTable(s) loaded from MANIFEST", lsm.sstable_count());
        }

        Ok(Self {
            wal,
            memtable,
            lsm,
            triggers: TriggerRegistry::new(),
            reject_duplicate_ids: false,
        })
    }

    // ── Write path ───────────────────────────────────────────────────────────

    /// Ek trade insert karo (WAL → MemTable, fully durable).
    ///
    /// Steps:
    ///   1. Built-in validation (price, qty, symbol, timestamp)
    ///   2. BEFORE triggers (user-defined checks)
    ///   3. Optional duplicate trade_id check
    ///   4. Sequence number assign karo
    ///   5. WAL par likho (commit point — crash ke baad yahan se recover hoga)
    ///   6. MemTable mein daalo
    ///   7. AFTER triggers (side effects — audit log, stats, etc.)
    ///   8. Auto-flush check (MemTable threshold)
    pub fn insert_trade(&mut self, mut trade: TradeRecord) -> Result<(), DbError> {
        // 1. Built-in validation
        validate(&trade)?;

        // 2. BEFORE triggers (user-defined, can abort)
        self.triggers.fire_before(&trade)?;

        // 3. Optional duplicate check
        if self.reject_duplicate_ids && self.get_trade(trade.trade_id).is_some() {
            return Err(DbError::Validation(format!(
                "trade_id {} already exists (duplicate rejected)", trade.trade_id
            )));
        }

        // 4. Sequence number (monotonically increasing)
        trade.seq_num = self.lsm.alloc_seq();

        // 5. WAL write (commit point)
        self.wal.append(&trade)?;

        // 6. MemTable
        self.memtable.insert(trade.clone());

        // 7. AFTER triggers
        self.triggers.fire_after(&trade);

        // 8. Auto-flush
        if self.memtable.should_flush() {
            self.flush_to_sstable()?;
        }

        Ok(())
    }

    /// Trade logically delete karo (tombstone insert via WAL + MemTable).
    /// Compaction mein tombstone eventually drop hota hai.
    pub fn delete_trade(&mut self, trade_id: u64) -> Result<(), DbError> {
        let seq       = self.lsm.alloc_seq();
        let tombstone = TradeRecord::tombstone(trade_id, seq);
        self.wal.append(&tombstone)?;
        self.memtable.insert(tombstone);
        Ok(())
    }

    // ── Read path ────────────────────────────────────────────────────────────

    /// trade_id se record dhundho.
    /// Order: MemTable → L0 (newest first) → L1 → L2 ...
    pub fn get_trade(&self, trade_id: u64) -> Option<TradeRecord> {
        // MemTable (freshest writes)
        if let Some(t) = self.memtable.get(trade_id) {
            return if t.deleted { None } else { Some(t.clone()) };
        }
        // SSTables via LSM engine (bloom + key range pre-filter)
        self.lsm.find_trade(trade_id)
    }

    /// Rich query engine — symbol, time-range, pagination, latest N.
    pub fn query(&self) -> QueryEngine<'_> {
        QueryEngine::new(self)
    }

    // ── Flush & Compaction ───────────────────────────────────────────────────

    /// Active MemTable ko SSTable mein flush karo (manual ya auto).
    /// WAL truncate hoti hai aur MemTable clear hoti hai.
    pub fn flush_to_sstable(&mut self) -> Result<(), DbError> {
        if self.memtable.is_empty() {
            return Ok(());
        }

        let trades   = self.memtable.snapshot();
        let sst_path = self.lsm.next_sst_path(0); // L0 flush

        write_sstable(&sst_path, &trades)?;
        let meta       = read_metadata(&sst_path)?;
        let rec_count  = meta.count;

        self.lsm.add_sstable(meta, 0); // L0 level mein add karo
        self.lsm.save_manifest()?;
        self.wal.truncate()?;          // WAL khaali karo
        self.memtable.clear();         // MemTable reset

        eprintln!("[DB] Flushed {rec_count} records → {sst_path}");

        // Auto-compaction: L0 threshold check
        if self.lsm.needs_compaction() {
            self.lsm.compact()?;
            self.lsm.save_manifest()?;
        }

        Ok(())
    }

    /// Manual compaction trigger karo (L0 → L1).
    pub fn compact(&mut self) -> Result<(), DbError> {
        self.lsm.compact()?;
        self.lsm.save_manifest()
    }

    // ── Stats / info ─────────────────────────────────────────────────────────

    pub fn memtable_len(&self) -> usize {
        self.memtable.len()
    }

    pub fn sstable_count(&self) -> usize {
        self.lsm.sstable_count()
    }

    pub fn memtable_size_bytes(&self) -> usize {
        self.memtable.size_bytes()
    }

    /// L0 / L1 / L2 file counts.
    pub fn level_sizes(&self) -> Vec<usize> {
        (0..3).map(|i| self.lsm.level_size(i)).collect()
    }

    pub fn data_dir(&self) -> &std::path::Path {
        &self.lsm.data_dir
    }
}
