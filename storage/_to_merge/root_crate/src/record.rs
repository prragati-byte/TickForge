// TradeRecord — TickForge DB ka primary data type.
//
// `seq_num`  : har write ke saath monotonically badhne wala number.
//              Compaction mein duplicate trade_id ka latest version decide karta hai.
//              #[serde(default)] → purane JSON records mein 0 hoga (legacy).
//
// `deleted`  : true = tombstone. Logical delete ke liye.
//              Compaction ke waqt bottom level par tombstones drop hoti hain.
//
// `price_paise`: paise mein price (1 INR = 100 paise). float avoid karo.
// `timestamp`  : unix milliseconds since epoch 1970-01-01T00:00:00Z.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TradeRecord {
    pub trade_id:    u64,
    pub symbol:      String,
    /// Price in paise (100 paise = 1 INR). Never use f64 for money.
    pub price_paise: u64,
    pub quantity:    u64,
    /// Unix milliseconds (ms since 1970-01-01 UTC).
    pub timestamp:   u64,
    /// Write-sequence number. Higher = more recent. 0 = legacy/unset.
    #[serde(default)]
    pub seq_num:  u64,
    /// Tombstone marker: true = this trade has been logically deleted.
    #[serde(default)]
    pub deleted:  bool,
}

impl TradeRecord {
    /// Tombstone record banao (logical delete ke liye).
    /// LSM compaction bottom level par ise drop kar deta hai.
    pub fn tombstone(trade_id: u64, seq_num: u64) -> Self {
        Self {
            trade_id,
            symbol:      String::new(),
            price_paise: 0,
            quantity:    0,
            timestamp:   0,
            seq_num,
            deleted: true,
        }
    }

    pub fn is_tombstone(&self) -> bool {
        self.deleted
    }
}
