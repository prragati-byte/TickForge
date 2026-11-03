//TradeRecord ek data structure hai issme trade ki saari details defined fields mein rakhi jaati hain
use serde::{Deserialize, Serialize};
/*Serialize — Rust struct ke data ko JSON jaise format mein convert karne ke liye
Deserialize — JSON jaise format se data ko wapas Rust struct mein convert karne ke liye*/
//derive rust ko automatically kuch functionality implement karne ke liye bolta hai

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeRecord {
    pub trade_id: u64,
    pub symbol: String,
    pub price_paise: u64,
    pub quantity: u64,
    pub timestamp: u64,
}
