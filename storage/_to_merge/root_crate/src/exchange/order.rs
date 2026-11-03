// Order types — Trading Exchange ke liye basic data structures.
//
// OrderSide: Buy (kharidna) ya Sell (bechna)
// OrderType: Limit (specific price par) ya Market (best available price par)
// OrderStatus: lifecycle tracking
//
// price_paise: hamesha paise mein (1 INR = 100 paise). float nahi!
// timestamp:   unix milliseconds.

use serde::{Deserialize, Serialize};

/// Buy side ya Sell side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderSide {
    Buy,
    Sell,
}

/// Limit order (specific price) ya Market order (best available).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderType {
    /// Execute karo `price_paise` par ya usse better.
    Limit,
    /// Immediately best available price par execute karo.
    Market,
}

/// Order ka lifecycle status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderStatus {
    Open,
    PartiallyFilled,
    Filled,
    Cancelled,
}

/// Ek buy/sell order jo matching engine ko submit kiya jaata hai.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub order_id:     u64,
    pub side:         OrderSide,
    pub order_type:   OrderType,
    pub symbol:       String,
    /// Limit price in paise. Market orders ke liye 0 rakho.
    pub price_paise:  u64,
    pub original_qty: u64,
    pub remaining_qty: u64,
    pub status:       OrderStatus,
    /// Unix milliseconds — order placement time.
    pub timestamp:    u64,
}

impl Order {
    /// Naya limit order banao.
    pub fn new_limit(
        order_id:    u64,
        side:        OrderSide,
        symbol:      impl Into<String>,
        price_paise: u64,
        quantity:    u64,
        timestamp:   u64,
    ) -> Self {
        Self {
            order_id,
            side,
            order_type:    OrderType::Limit,
            symbol:        symbol.into(),
            price_paise,
            original_qty:  quantity,
            remaining_qty: quantity,
            status:        OrderStatus::Open,
            timestamp,
        }
    }

    /// Naya market order banao (price_paise = 0).
    pub fn new_market(
        order_id:  u64,
        side:      OrderSide,
        symbol:    impl Into<String>,
        quantity:  u64,
        timestamp: u64,
    ) -> Self {
        Self {
            order_id,
            side,
            order_type:    OrderType::Market,
            symbol:        symbol.into(),
            price_paise:   0,
            original_qty:  quantity,
            remaining_qty: quantity,
            status:        OrderStatus::Open,
            timestamp,
        }
    }

    pub fn is_filled(&self) -> bool {
        self.remaining_qty == 0 || self.status == OrderStatus::Filled
    }

    pub fn is_active(&self) -> bool {
        self.remaining_qty > 0 && self.status != OrderStatus::Cancelled
    }
}
