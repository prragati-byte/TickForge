// LSM Engine — Level-Structured Merge Tree ka central coordinator.
//
// Architecture:
//   Level 0 (L0): MemTable flush ka direct output.
//                 Key ranges overlap allowed. L0_COMPACT_THRESHOLD se zyada files
//                 hone par compaction trigger hoti hai.
//   Level 1 (L1): L0 ka compacted output. Key ranges overlap nahi karte.
//   Level 2 (L2): L1 ka compacted output. (Future growth ke liye)
//
// Write path:
//   MemTable flush → L0 SSTable → [auto-compact] → L1 SSTable
//
// Read path (newest → oldest):
//   L0 (newest first, all files) → L1 (newest first) → L2 ...
//   Bloom + key-range pre-filter → disk read avoid.
//
// MANIFEST format (v2):
//   SEQ:{next_seq-1}        ← sequence number checkpoint
//   FILE_ID:{n}             ← file id checkpoint
//   L:{level}:{path}        ← one line per live SSTable
//
// Crash recovery: MANIFEST load → SST metadata restore. WAL replay upar se.

pub mod compaction;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::DbError;
use crate::record::TradeRecord;
use crate::sstable::{find_trade, read_all_trades, read_metadata, write_sstable, SstableMetadata};

const MANIFEST_FILE: &str = "MANIFEST";

/// L0 mein itni files hone par compaction trigger hogi.
pub const L0_COMPACT_THRESHOLD: usize = 4;

pub struct LsmEngine {
    /// levels[0] = L0, levels[1] = L1, ...
    /// levels[i] = SstableMetadata ki list (chronological order).
    pub(crate) levels: Vec<Vec<SstableMetadata>>,
    pub data_dir:      PathBuf,
    pub next_file_id:  u64,
    /// Global write sequence number. Har insert par alloc_seq() se badhta hai.
    pub next_seq:      u64,
}

impl LsmEngine {
    // ── Lifecycle ────────────────────────────────────────────────────────────

    /// Data directory se engine kholo (MANIFEST load karo).
    pub fn open(data_dir: PathBuf) -> Result<Self, DbError> {
        fs::create_dir_all(&data_dir)?;
        let mut engine = Self {
            levels:       Vec::new(),
            data_dir,
            next_file_id: 0,
            next_seq:     1,
        };
        engine.load_manifest()?;
        Ok(engine)
    }

    // ── Sequence numbers ─────────────────────────────────────────────────────

    /// Next monotonic sequence number allocate karo (har write ke liye).
    pub fn alloc_seq(&mut self) -> u64 {
        let s = self.next_seq;
        self.next_seq += 1;
        s
    }

    // ── File paths ───────────────────────────────────────────────────────────

    /// Is level ke liye next SSTable path generate karo.
    pub fn next_sst_path(&mut self, level: usize) -> String {
        let id = self.next_file_id;
        self.next_file_id += 1;
        self.data_dir
            .join(format!("sst_l{level}_{id:06}.sst"))
            .to_string_lossy()
            .to_string()
    }

    // ── SSTable management ───────────────────────────────────────────────────

    /// Ek naya SSTable diye gaye level par add karo.
    pub fn add_sstable(&mut self, meta: SstableMetadata, level: usize) {
        while self.levels.len() <= level {
            self.levels.push(Vec::new());
        }
        self.levels[level].push(meta);
    }

    /// Sabhi levels ka total SSTable count.
    pub fn sstable_count(&self) -> usize {
        self.levels.iter().map(|l| l.len()).sum()
    }

    /// Specific level ka SSTable count.
    pub fn level_size(&self, level: usize) -> usize {
        self.levels.get(level).map(|l| l.len()).unwrap_or(0)
    }

    /// Kya abhi compaction karni chahiye?
    pub fn needs_compaction(&self) -> bool {
        self.level_size(0) >= L0_COMPACT_THRESHOLD
    }

    // ── Read path ────────────────────────────────────────────────────────────

    /// trade_id saare SSTable levels mein dhundho.
    ///
    /// Search order: L0 newest-first (all files, overlapping allowed)
    ///               → L1 newest-first → L2 ...
    /// First hit jeet ta hai (newest data).
    pub fn find_trade(&self, trade_id: u64) -> Option<TradeRecord> {
        // L0: files mein key ranges overlap → sab check karo, newest first
        if let Some(l0) = self.levels.get(0) {
            for meta in l0.iter().rev() {
                if !meta.might_contain(trade_id) {
                    continue; // bloom + key range: definitely not here
                }
                match find_trade(&meta.path, trade_id) {
                    Ok(Some(t)) => return if t.deleted { None } else { Some(t) },
                    Ok(None)    => {}
                    Err(e)      => eprintln!("[LSM] L0 read err {}: {e}", meta.path),
                }
            }
        }

        // L1+: within-level no overlap → first match per level
        for lvl in 1..self.levels.len() {
            if let Some(files) = self.levels.get(lvl) {
                for meta in files.iter().rev() {
                    if !meta.might_contain(trade_id) {
                        continue;
                    }
                    match find_trade(&meta.path, trade_id) {
                        Ok(Some(t)) => return if t.deleted { None } else { Some(t) },
                        Ok(None)    => {}
                        Err(e)      => eprintln!("[LSM] L{lvl} read err {}: {e}", meta.path),
                    }
                }
            }
        }
        None
    }

    /// Sabhi SSTable metadata — query engine ke liye.
    pub fn all_sstables(&self) -> Vec<(usize, &SstableMetadata)> {
        self.levels
            .iter()
            .enumerate()
            .flat_map(|(lvl, files)| files.iter().map(move |m| (lvl, m)))
            .collect()
    }

    // ── Compaction ───────────────────────────────────────────────────────────

    /// L0 → L1 compaction. L0_COMPACT_THRESHOLD se trigger hoti hai.
    ///
    /// Steps:
    ///   1. L0 + current L1 records collect karo
    ///   2. merge_records: dedup by (trade_id, seq_num DESC), drop tombstones at bottom
    ///   3. New L1 SSTable atomically likho
    ///   4. MANIFEST update (crash-safe)
    ///   5. Old files delete karo
    pub fn compact(&mut self) -> Result<(), DbError> {
        if !self.needs_compaction() {
            return Ok(());
        }

        let l0_count = self.level_size(0);
        eprintln!("[LSM] Compaction start: L0={l0_count} files");

        let l0_metas: Vec<SstableMetadata> = self.levels.get(0).cloned().unwrap_or_default();
        let l1_metas: Vec<SstableMetadata> = self.levels.get(1).cloned().unwrap_or_default();

        // Collect all records
        let mut all_records: Vec<TradeRecord> = Vec::new();
        for meta in &l0_metas { all_records.extend(read_all_trades(&meta.path)?); }
        for meta in &l1_metas { all_records.extend(read_all_trades(&meta.path)?); }

        // Is L1 the bottom level? (no L2 data yet)
        let is_bottom = self.level_size(2) == 0;

        let merged = compaction::merge_records(all_records, is_bottom);

        // Paths to delete (collected before mutating self.levels)
        let l0_paths: HashSet<String> = l0_metas.iter().map(|m| m.path.clone()).collect();
        let l1_paths: HashSet<String> = l1_metas.iter().map(|m| m.path.clone()).collect();

        // Remove compacted files from level lists
        if let Some(l0) = self.levels.get_mut(0) {
            l0.retain(|m| !l0_paths.contains(&m.path));
        }
        if let Some(l1) = self.levels.get_mut(1) {
            l1.retain(|m| !l1_paths.contains(&m.path));
        }

        // Write new L1 SSTable (if any records survive)
        if !merged.is_empty() {
            let new_path = self.next_sst_path(1);
            write_sstable(&new_path, &merged)?;
            let new_meta = read_metadata(&new_path)?;
            while self.levels.len() <= 1 { self.levels.push(Vec::new()); }
            self.levels[1].push(new_meta);
        }

        // ── Crash-safe: MANIFEST first, then delete old files ────────────
        self.save_manifest()?;

        for path in l0_paths.iter().chain(l1_paths.iter()) {
            if let Err(e) = fs::remove_file(path) {
                eprintln!("[LSM] Delete failed {path}: {e}");
            }
        }

        eprintln!("[LSM] Compaction done: {} records in new L1", merged.len());
        Ok(())
    }

    // ── MANIFEST I/O ─────────────────────────────────────────────────────────

    /// MANIFEST ko atomically disk par save karo.
    pub fn save_manifest(&self) -> Result<(), DbError> {
        let path = self.data_dir.join(MANIFEST_FILE);
        let tmp  = path.with_extension("tmp");

        let mut content = format!(
            "SEQ:{}\nFILE_ID:{}\n",
            self.next_seq.saturating_sub(1),
            self.next_file_id.saturating_sub(1),
        );

        for (lvl, files) in self.levels.iter().enumerate() {
            for meta in files {
                content.push_str(&format!("L:{}:{}\n", lvl, meta.path));
            }
        }

        fs::write(&tmp, &content)?;
        fs::rename(&tmp, &path)?;
        Ok(())
    }

    fn load_manifest(&mut self) -> Result<(), DbError> {
        let path = self.data_dir.join(MANIFEST_FILE);
        if !path.exists() {
            return Ok(());
        }

        let content = fs::read_to_string(&path)?;
        let mut max_seq     = 0u64;
        let mut max_file_id = 0u64;

        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() { continue; }

            if let Some(v) = line.strip_prefix("SEQ:") {
                max_seq = v.parse().unwrap_or(0);
            } else if let Some(v) = line.strip_prefix("FILE_ID:") {
                max_file_id = v.parse().unwrap_or(0);
            } else if let Some(rest) = line.strip_prefix("L:") {
                let mut parts = rest.splitn(2, ':');
                let level: usize = parts.next()
                    .and_then(|s| s.parse().ok()).unwrap_or(0);
                let sst_path = match parts.next() { Some(p) => p, None => continue };

                if Path::new(sst_path).exists() {
                    match read_metadata(sst_path) {
                        Ok(meta) => self.add_sstable(meta, level),
                        Err(e)   => eprintln!("[LSM] MANIFEST skip {sst_path}: {e}"),
                    }
                } else {
                    eprintln!("[LSM] MANIFEST: {sst_path} not found, skip");
                }
            }
        }

        self.next_seq     = max_seq + 1;
        self.next_file_id = max_file_id + 1;
        Ok(())
    }
}
