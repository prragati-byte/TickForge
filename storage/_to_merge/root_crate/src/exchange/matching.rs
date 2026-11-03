// MatchingEngine — multiple symbols ke order books manage karta hai.
//
// Integration pattern:
//   let mut engine = MatchingEngine::new();
//   let trades = engine.limit_buy("TCS", 350_000, 10, ts)?;
//   for trade in trades {
//       db.insert_trade(trade)?;   // trades persist ho jaate hain
//   }
//
// Engine Database se independent hai — circular dependency nahi.
// Caller trades ko DB mein insert karta hai.
//
// Supported operations:
//   limit_buy / limit_sell   → order book par add, match karo
//   market_buy / market_sell → immediately match, remainder abandon
//   cancel_order             → order book se mark cancelled
//   best_bid / best_ask      → market data
//   submit_order             → generic, flexible

use std::collections::HashMap;

use crate::error::DbError;
use crate::exchange::order::{Order, OrderSide, OrderType};
use crate::exchange::order_book::OrderBook;
use crate::record::TradeRecord;

pub struct MatchingEngine {
    books:          HashMap<String, OrderBook>,
    pub next_order_id: u64,
    pub next_trade_id: u64,
}

impl MatchingEngine {
    pub fn new() -> Self {
        Self {
            books:         HashMap::new(),
            next_order_id: 1,
            next_trade_id: 1,
        }
    }

    // ── High-level convenience methods ───────────────────────────────────────

    /// Limit buy order submit karo.
    pub fn limit_buy(
        &mut self,
        symbol:      &str,
        price_paise: u64,
        quantity:    u64,
        timestamp:   u64,
    ) -> Result<Vec<TradeRecord>, DbError> {
        let id  = self.alloc_order_id();
        let ord = Order::new_limit(id, OrderSide::Buy, symbol, price_paise, quantity, timestamp);
        self.submit_order(ord)
    }

    /// Limit sell order submit karo.
    pub fn limit_sell(
        &mut self,
        symbol:      &str,
        price_paise: u64,
        quantity:    u64,
        timestamp:   u64,
    ) -> Result<Vec<TradeRecord>, DbError> {
        let id  = self.alloc_order_id();
        let ord = Order::new_limit(id, OrderSide::Sell, symbol, price_paise, quantity, timestamp);
        self.submit_order(ord)
    }

    /// Market buy order submit karo (best available ask par).
    pub fn market_buy(
        &mut self,
        symbol:    &str,
        quantity:  u64,
        timestamp: u64,
    ) -> Result<Vec<TradeRecord>, DbError> {
        let id  = self.alloc_order_id();
        let ord = Order::new_market(id, OrderSide::Buy, symbol, quantity, timestamp);
        self.submit_order(ord)
    }

    /// Market sell order submit karo (best available bid par).
    pub fn market_sell(
        &mut self,
        symbol:    &str,
        quantity:  u64,
        timestamp: u64,
    ) -> Result<Vec<TradeRecord>, DbError> {
        let id  = self.alloc_order_id();
        let ord = Order::new_market(id, OrderSide::Sell, symbol, quantity, timestamp);
        self.submit_order(ord)
    }

    // ── Core order submission ────────────────────────────────────────────────

    /// Generic order submit karo. Returns generated TradeRecords.
    /// Unmatched limit order remainder book mein add hota hai.
    /// Market order remainder abandon hota hai.
    pub fn submit_order(&mut self, mut order: Order) -> Result<Vec<TradeRecord>, DbError> {
        let symbol = order.symbol.clone();
        let book   = self.books
            .entry(symbol.clone())
            .or_insert_with(|| OrderBook::new(&symbol));

        let ts     = order.timestamp;
        let trades = book.match_order(&mut order, &mut self.next_trade_id, ts);

        // Unmatched limit orders: book mein daalo
        if order.remaining_qty > 0 && order.order_type == OrderType::Limit {
            match order.side {
                OrderSide::Buy  => book.add_bid(order),
                OrderSide::Sell => book.add_ask(order),
            }
        }
        // Market order remainder: abandon (no book placement)

        Ok(trades)
    }

    // ── Order cancellation ───────────────────────────────────────────────────

    /// Order cancel karo. Returns true agar found aur cancelled.
    pub fn cancel_order(&mut self, symbol: &str, order_id: u64) -> bool {
        self.books
            .get_mut(symbol)
            .map(|b| b.cancel_order(order_id))
            .unwrap_or(false)
    }

    // ── Market data ──────────────────────────────────────────────────────────

    pub fn best_bid(&self, symbol: &str) -> Option<u64> {
        self.books.get(symbol)?.best_bid()
    }

    pub fn best_ask(&self, symbol: &str) -> Option<u64> {
        self.books.get(symbol)?.best_ask()
    }

    pub fn spread(&self, symbol: &str) -> Option<u64> {
        self.books.get(symbol)?.spread()
    }

    pub fn open_orders(&self, symbol: &str) -> usize {
        self.books.get(symbol).map(|b| b.open_order_count()).unwrap_or(0)
    }

    pub fn order_book(&self, symbol: &str) -> Option<&OrderBook> {
        self.books.get(symbol)
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    fn alloc_order_id(&mut self) -> u64 {
        let id = self.next_order_id;
        self.next_order_id += 1;
        id
    }
}

impl Default for MatchingEngine {
    fn default() -> Self { Self::new() }
}
