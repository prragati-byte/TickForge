use crate::error::DbError;
use crate::log::Log;
use crate::memtable::MemTable;
use crate::record::Trade;
use crate::sstable::SsTable;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/// The memtable is flushed to an SSTable when it holds this many trades.
const MEMTABLE_LIMIT: usize = 10_000;
/// After an automatic flush, compact if there are this many SSTables.
const AUTO_COMPACT_AT: usize = 8;
/// SSTables count as "the same size" if the biggest is at most this many
/// times the smallest.
const TIER_FACTOR: u64 = 4;

pub struct Database {
    dir: PathBuf,
    log: Log,
    mem: MemTable,
    /// (file number, table), oldest first. A newer table wins over an older one.
    tables: Vec<(u64, SsTable)>,
    next_number: u64,
    /// Number of distinct trade ids.
    distinct: u64,
}

fn table_path(dir: &Path, number: u64) -> PathBuf {
    dir.join(format!("sst-{number}.tfs"))
}

impl Database {
    /// Open the directory (creating it if needed): load the SSTables, then
    /// replay the log into the memtable.
    pub fn open(dir: &Path) -> Result<Database, DbError> {
        fs::create_dir_all(dir)?;

        let mut numbers = Vec::new();
        for entry in fs::read_dir(dir)? {
            let path = entry?.path();
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            if name.ends_with(".tmp") {
                fs::remove_file(&path)?; // left over from a crash while writing
            } else if let Some(n) = name
                .strip_prefix("sst-")
                .and_then(|r| r.strip_suffix(".tfs"))
            {
                if let Ok(n) = n.parse::<u64>() {
                    numbers.push(n);
                }
            }
        }
        numbers.sort_unstable();

        let mut tables = Vec::new();
        for n in &numbers {
            tables.push((*n, SsTable::open(&table_path(dir, *n))?));
        }

        let mut mem = MemTable::default();
        let log = Log::open(&dir.join("wal.log"), |t| mem.insert(t))?;

        let mut ids: HashSet<u64> = mem.iter().map(|t| t.trade_id).collect();
        for (_, table) in &tables {
            ids.extend(table.all()?.iter().map(|t| t.trade_id));
        }

        Ok(Database {
            dir: dir.to_path_buf(),
            log,
            mem,
            next_number: numbers.last().map_or(1, |n| n + 1),
            tables,
            distinct: ids.len() as u64,
        })
    }

    /// Store a trade. When this returns, the trade is in the log and survives
    /// a crash. A trade with an existing id replaces the old one.
    pub fn insert_trade(&mut self, trade: Trade) -> Result<(), DbError> {
        trade.validate()?;
        let existed = self.get_trade(trade.trade_id)?.is_some();
        self.log.append(&trade)?;
        self.mem.insert(trade);
        if !existed {
            self.distinct += 1;
        }
        if self.mem.len() >= MEMTABLE_LIMIT {
            self.flush()?;
            if self.tables.len() >= AUTO_COMPACT_AT {
                self.compact()?;
            }
        }
        Ok(())
    }

    pub fn get_trade(&self, trade_id: u64) -> Result<Option<Trade>, DbError> {
        if let Some(t) = self.mem.get(trade_id) {
            return Ok(Some(t.clone()));
        }
        for (_, table) in self.tables.iter().rev() {
            if let Some(t) = table.get(trade_id)? {
                return Ok(Some(t));
            }
        }
        Ok(None)
    }

    /// Trades with start_ms <= timestamp_ms < end_ms, optionally for one
    /// symbol, sorted by (timestamp_ms, trade_id).
    pub fn range(
        &self,
        start_ms: u64,
        end_ms: u64,
        symbol: Option<&str>,
    ) -> Result<Vec<Trade>, DbError> {
        let wanted = |t: &Trade| symbol.is_none_or(|s| t.symbol == s);
        let mut out: Vec<Trade> = self
            .mem
            .iter()
            .filter(|t| t.timestamp_ms >= start_ms && t.timestamp_ms < end_ms && wanted(t))
            .cloned()
            .collect();

        for (i, (_, table)) in self.tables.iter().enumerate() {
            for t in table.range(start_ms, end_ms)? {
                // If a newer copy of this trade exists, that copy is the real one.
                if wanted(&t) && !self.replaced_after(t.trade_id, i)? {
                    out.push(t);
                }
            }
        }
        out.sort_by_key(|t| (t.timestamp_ms, t.trade_id));
        Ok(out)
    }

    /// Is there a copy of `trade_id` in the memtable or in a table newer than `tables[i]`?
    fn replaced_after(&self, trade_id: u64, i: usize) -> Result<bool, DbError> {
        if self.mem.contains(trade_id) {
            return Ok(true);
        }
        for (_, newer) in &self.tables[i + 1..] {
            if newer.get(trade_id)?.is_some() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Number of distinct trade ids.
    pub fn count(&self) -> u64 {
        self.distinct
    }

    /// Write the memtable to a new SSTable and empty the log.
    pub fn flush(&mut self) -> Result<(), DbError> {
        if self.mem.is_empty() {
            return Ok(());
        }
        let path = table_path(&self.dir, self.next_number);
        SsTable::write(&path, &self.mem.sorted())?;
        let table = SsTable::open(&path)?;
        self.tables.push((self.next_number, table));
        self.next_number += 1;
        self.mem.clear();
        self.log.reset()?;
        Ok(())
    }

    /// Size-tiered compaction: find the longest run of neighbouring SSTables
    /// of similar size and merge it into one. Returns how many were merged
    /// (0 if there is no run of two or more).
    ///
    /// Only neighbours are merged, so "newer wins" stays true. The result takes
    /// the file number of the newest table in the run.
    pub fn compact(&mut self) -> Result<usize, DbError> {
        let sizes: Vec<u64> = self.tables.iter().map(|(_, t)| t.file_size()).collect();
        let (mut first, mut len) = (0, 0);
        for start in 0..sizes.len() {
            let (mut small, mut big) = (sizes[start], sizes[start]);
            let mut end = start + 1;
            while end < sizes.len() {
                let (s, b) = (small.min(sizes[end]), big.max(sizes[end]));
                if b > s * TIER_FACTOR {
                    break;
                }
                small = s;
                big = b;
                end += 1;
            }
            if end - start > len {
                first = start;
                len = end - start;
            }
        }
        if len < 2 {
            return Ok(0);
        }

        // Newest first, so the first copy of an id we see is the one to keep.
        let mut seen = HashSet::new();
        let mut merged = Vec::new();
        for (_, table) in self.tables[first..first + len].iter().rev() {
            for t in table.all()? {
                if seen.insert(t.trade_id) {
                    merged.push(t);
                }
            }
        }
        merged.sort_by_key(|t| (t.timestamp_ms, t.trade_id));

        let number = self.tables[first + len - 1].0;
        let path = table_path(&self.dir, number);
        SsTable::write(&path, &merged)?; // replaces the newest input file atomically
        let new_table = SsTable::open(&path)?;

        for (n, _) in &self.tables[first..first + len - 1] {
            fs::remove_file(table_path(&self.dir, *n))?;
        }
        self.tables
            .splice(first..first + len, [(number, new_table)]);
        Ok(len)
    }

    /// Number of SSTable files (for tests and monitoring).
    pub fn table_count(&self) -> usize {
        self.tables.len()
    }
}
