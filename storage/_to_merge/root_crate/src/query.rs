// Query Engine — TickForge DB par rich read operations.
//
// Har query MemTable + saare SSTable levels merge karti hai:
//   1. MemTable snapshot + SSTable records collect karo
//   2. deduplicate: same trade_id → highest seq_num jeeta hai
//   3. Tombstones filter karo (deleted = true)
//   4. Filter/sort/paginate apply karo
//
// Supported queries:
//   all()                           → saare live trades
//   by_symbol(sym)                  → specific symbol ke trades
//   by_time_range(from, to)         → timestamp range [from, to]
//   by_symbol_and_time_range(...)   → symbol + time range
//   latest(n)                       → N most recent (timestamp DESC)
//   paginate(page, page_size)       → paginated (trade_id ASC)
//
// QueryResult.files_scanned: query mein kitni SSTable files disk se padhi gayin.
//   0 → sirf MemTable use hua (fastest)
//   n → n SSTable files scan hui

use std::collections::HashMap;

use crate::database::Database;
use crate::error::DbError;
use crate::record::TradeRecord;
use crate::sstable::read_all_trades;

/// Query operation ka result.
#[derive(Debug)]
pub struct QueryResult {
    pub trades:                Vec<TradeRecord>,
    /// Pagination se pehle total matching records count.
    pub total_before_page:     usize,
    /// Kitni SSTable files disk se read hui (perf measurement).
    pub files_scanned:         usize,
}

/// Query engine — database ka immutable borrow leta hai.
/// Usage: `db.query().by_symbol("TCS")`
pub struct QueryEngine<'a> {
    db: &'a Database,
}

impl<'a> QueryEngine<'a> {
    pub fn new(db: &'a Database) -> Self {
        Self { db }
    }

    /// Saare live trades (deduped, tombstones removed).
    pub fn all(&self) -> Result<QueryResult, DbError> {
        let (records, files) = self.collect(None, None)?;
        let trades = deduplicate(records);
        Ok(QueryResult {
            total_before_page: trades.len(),
            trades,
            files_scanned: files,
        })
    }

    /// Ek specific symbol ke saare trades.
    pub fn by_symbol(&self, symbol: &str) -> Result<QueryResult, DbError> {
        let (records, files) = self.collect(None, None)?;
        let deduped: Vec<_> = deduplicate(records)
            .into_iter()
            .filter(|t| t.symbol == symbol)
            .collect();
        Ok(QueryResult {
            total_before_page: deduped.len(),
            trades: deduped,
            files_scanned: files,
        })
    }

    /// Timestamp range [from_ts, to_ts] (inclusive) ke saare trades.
    pub fn by_time_range(&self, from_ts: u64, to_ts: u64) -> Result<QueryResult, DbError> {
        let (records, files) = self.collect(Some(from_ts), Some(to_ts))?;
        let deduped: Vec<_> = deduplicate(records)
            .into_iter()
            .filter(|t| t.timestamp >= from_ts && t.timestamp <= to_ts)
            .collect();
        Ok(QueryResult {
            total_before_page: deduped.len(),
            trades: deduped,
            files_scanned: files,
        })
    }

    /// Symbol + timestamp range combination query.
    pub fn by_symbol_and_time_range(
        &self,
        symbol: &str,
        from_ts: u64,
        to_ts: u64,
    ) -> Result<QueryResult, DbError> {
        let (records, files) = self.collect(Some(from_ts), Some(to_ts))?;
        let deduped: Vec<_> = deduplicate(records)
            .into_iter()
            .filter(|t| t.symbol == symbol && t.timestamp >= from_ts && t.timestamp <= to_ts)
            .collect();
        Ok(QueryResult {
            total_before_page: deduped.len(),
            trades: deduped,
            files_scanned: files,
        })
    }

    /// N most recent trades (timestamp DESC).
    pub fn latest(&self, n: usize) -> Result<QueryResult, DbError> {
        let (records, files) = self.collect(None, None)?;
        let mut deduped = deduplicate(records);
        deduped.sort_unstable_by(|a, b| b.timestamp.cmp(&a.timestamp));
        let total = deduped.len();
        deduped.truncate(n);
        Ok(QueryResult {
            total_before_page: total,
            trades: deduped,
            files_scanned: files,
        })
    }

    /// Paginated results (trade_id ASC). page is 0-indexed.
    pub fn paginate(&self, page: usize, page_size: usize) -> Result<QueryResult, DbError> {
        assert!(page_size > 0, "page_size > 0 hona chahiye");
        let (records, files) = self.collect(None, None)?;
        let mut deduped = deduplicate(records);
        deduped.sort_unstable_by_key(|t| t.trade_id);
        let total  = deduped.len();
        let start  = page * page_size;
        let trades = if start >= total {
            vec![]
        } else {
            deduped[start..(start + page_size).min(total)].to_vec()
        };
        Ok(QueryResult {
            total_before_page: total,
            trades,
            files_scanned: files,
        })
    }

    // ── Internal ────────────────────────────────────────────────────────────

    /// MemTable + relevant SSTables se records collect karo.
    /// from_ts/to_ts se SSTable timestamp range pre-filter hota hai.
    fn collect(
        &self,
        from_ts: Option<u64>,
        to_ts: Option<u64>,
    ) -> Result<(Vec<TradeRecord>, usize), DbError> {
        let mut all = Vec::new();
        let mut files = 0usize;

        // MemTable (always fresh, no disk I/O)
        all.extend(self.db.memtable.snapshot());

        // SSTables with timestamp pre-filter
        for (_, meta) in self.db.lsm.all_sstables() {
            let include = match (from_ts, to_ts) {
                (Some(f), Some(t)) => meta.might_contain_ts_range(f, t),
                (Some(f), None)    => meta.max_ts >= f,
                (None,    Some(t)) => meta.min_ts <= t,
                (None,    None)    => true,
            };
            if !include { continue; }
            files += 1;
            all.extend(read_all_trades(&meta.path)?);
        }

        Ok((all, files))
    }
}

/// Records deduplicate karo: per trade_id highest seq_num rakho, tombstones hatao.
fn deduplicate(mut records: Vec<TradeRecord>) -> Vec<TradeRecord> {
    records.sort_unstable_by(|a, b| {
        a.trade_id
            .cmp(&b.trade_id)
            .then_with(|| b.seq_num.cmp(&a.seq_num)) // desc seq
    });

    let mut seen: HashMap<u64, ()> = HashMap::new();
    let mut out  = Vec::new();

    for r in records {
        if seen.contains_key(&r.trade_id) { continue; }
        seen.insert(r.trade_id, ());
        if !r.deleted { out.push(r); }
    }
    out
}
