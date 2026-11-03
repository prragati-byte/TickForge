// Compaction — multiple SSTables ko merge karke ek clean SSTable banao.
//
// Algorithm (sort-merge):
//   1. Saare input records collect karo
//   2. Sort karo: primary = trade_id ASC, secondary = seq_num DESC
//      (highest seq_num = newest write → jeetega)
//   3. Duplicate trade_ids mein sirf pehla (highest seq) rakho
//   4. is_bottom_level = true ho to tombstones drop karo
//      (bottom pe koi purana data nahi → tombstone ka kaam khatam)
//
// "Bottom level" = highest numbered level jisme data hai.
// L0 compaction (L0 → L1): agar L2 khaali hai, L1 = bottom level.
//
// Write amplification: har compaction mein data rewrite hota hai.
// Yahi LSM ka tradeoff hai — writes fast, reads eventually consistent.

use crate::record::TradeRecord;

/// Multiple SSTables ke records merge karo, deduplicate karo, tombstones handle karo.
///
/// Returns: sorted, deduplicated records ready for new SSTable.
pub fn merge_records(mut records: Vec<TradeRecord>, is_bottom_level: bool) -> Vec<TradeRecord> {
    if records.is_empty() {
        return records;
    }

    // Sort: trade_id asc, seq_num desc (newest first per ID)
    records.sort_unstable_by(|a, b| {
        a.trade_id
            .cmp(&b.trade_id)
            .then_with(|| b.seq_num.cmp(&a.seq_num))
    });

    let mut result = Vec::with_capacity(records.len());
    let mut last_id = u64::MAX; // sentinel

    for record in records {
        if record.trade_id == last_id {
            continue; // same ID, lower seq_num → skip (older version)
        }
        last_id = record.trade_id;

        if is_bottom_level && record.deleted {
            // Tombstone at bottom level: no older data can surface → discard
            continue;
        }

        result.push(record);
    }

    result
}

// ── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::TradeRecord;

    fn live(id: u64, seq: u64) -> TradeRecord {
        TradeRecord {
            trade_id:    id,
            symbol:      format!("SYM{id}"),
            price_paise: 100_000,
            quantity:    1,
            timestamp:   1_700_000_000 + seq,
            seq_num:     seq,
            deleted:     false,
        }
    }

    fn tomb(id: u64, seq: u64) -> TradeRecord {
        TradeRecord::tombstone(id, seq)
    }

    #[test]
    fn dedup_keeps_highest_seq() {
        let recs = vec![live(1, 1), live(1, 3), live(1, 2)];
        let out  = merge_records(recs, false);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].seq_num, 3);
    }

    #[test]
    fn multiple_ids_all_kept() {
        let recs = vec![live(2, 1), live(1, 2), live(3, 1)];
        let out  = merge_records(recs, false);
        assert_eq!(out.len(), 3);
        // sorted by trade_id
        assert_eq!(out[0].trade_id, 1);
        assert_eq!(out[1].trade_id, 2);
        assert_eq!(out[2].trade_id, 3);
    }

    #[test]
    fn tombstone_kept_at_non_bottom() {
        let out = merge_records(vec![tomb(5, 2)], false);
        assert_eq!(out.len(), 1);
        assert!(out[0].deleted);
    }

    #[test]
    fn tombstone_dropped_at_bottom() {
        let out = merge_records(vec![tomb(5, 2)], true);
        assert!(out.is_empty());
    }

    #[test]
    fn tombstone_beats_older_live_at_non_bottom() {
        // tomb seq=2 beats live seq=1 → tombstone kept
        let out = merge_records(vec![live(1, 1), tomb(1, 2)], false);
        assert_eq!(out.len(), 1);
        assert!(out[0].deleted);
    }

    #[test]
    fn tombstone_beats_older_live_at_bottom_and_both_dropped() {
        let out = merge_records(vec![live(1, 1), tomb(1, 2)], true);
        assert!(out.is_empty());
    }
}
