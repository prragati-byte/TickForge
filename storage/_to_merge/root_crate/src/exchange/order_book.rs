// OrderBook — ek symbol ke liye buy/sell orders ka sorted container.
//
// Price-Time Priority (standard exchange matching rule):
//   Best bid  = highest buy price (BTreeMap mein max key)
//   Best ask  = lowest sell price (BTreeMap mein min key)
//   Same price par: pehle aaya order pehle match hota hai (FIFO VecDeque)
//
// Bids (buy orders):  BTreeMap<price, VecDeque<Order>> — keys ascending
//                     best bid = keys().next_back()
// Asks (sell orders): BTreeMap<price, VecDeque<Order>> — keys ascending
//                     best ask = keys().next()
//
// Match kaise hota hai:
//   Incoming buy:  best ask < buy_price → match (seller ka price chalta hai)
//   Incoming sell: best bid > sell_price → match (buyer ka price chalta hai)
//   Partial fill: remaining_qty update hoti hai, order book mein rehta hai.

use std::collections::{BTreeMap, VecDeque};

use crate::exchange::order::{Order, OrderSide, OrderStatus, OrderType};
use crate::record::TradeRecord;

pub struct OrderBook {
    pub symbol: String,
    /// Buy orders: price → FIFO queue. Best bid = max key.
    bids: BTreeMap<u64, VecDeque<Order>>,
    /// Sell orders: price → FIFO queue. Best ask = min key.
    asks: BTreeMap<u64, VecDeque<Order>>,
}

impl OrderBook {
    pub fn new(symbol: impl Into<String>) -> Self {
        Self {
            symbol: symbol.into(),
            bids:   BTreeMap::new(),
            asks:   BTreeMap::new(),
        }
    }

    // ── Market data ─────────────────────────────────────────────────────────

    /// Best bid price (highest buy price). None agar koi buyer nahi.
    pub fn best_bid(&self) -> Option<u64> {
        self.bids.keys().next_back().copied()
    }

    /// Best ask price (lowest sell price). None agar koi seller nahi.
    pub fn best_ask(&self) -> Option<u64> {
        self.asks.keys().next().copied()
    }

    /// Bid-Ask spread (paise mein). None agar ek side empty hai.
    pub fn spread(&self) -> Option<u64> {
        let bid = self.best_bid()?;
        let ask = self.best_ask()?;
        if ask >= bid { Some(ask - bid) } else { None }
    }

    /// Active (non-cancelled, non-filled) order count.
    pub fn open_order_count(&self) -> usize {
        let b: usize = self.bids.values().map(|q| q.iter().filter(|o| o.is_active()).count()).sum();
        let a: usize = self.asks.values().map(|q| q.iter().filter(|o| o.is_active()).count()).sum();
        b + a
    }

    // ── Order placement ──────────────────────────────────────────────────────

    /// Limit bid order book mein add karo (bina match kiye).
    pub fn add_bid(&mut self, order: Order) {
        self.bids.entry(order.price_paise).or_default().push_back(order);
    }

    /// Limit ask order book mein add karo (bina match kiye).
    pub fn add_ask(&mut self, order: Order) {
        self.asks.entry(order.price_paise).or_default().push_back(order);
    }

    // ── Order cancellation ───────────────────────────────────────────────────

    /// order_id se order cancel karo (dono sides mein dhundho).
    /// Returns true agar mila aur cancel hua.
    pub fn cancel_order(&mut self, order_id: u64) -> bool {
        for queue in self.bids.values_mut() {
            if let Some(o) = queue.iter_mut().find(|o| o.order_id == order_id) {
                o.status        = OrderStatus::Cancelled;
                o.remaining_qty = 0;
                return true;
            }
        }
        for queue in self.asks.values_mut() {
            if let Some(o) = queue.iter_mut().find(|o| o.order_id == order_id) {
                o.status        = OrderStatus::Cancelled;
                o.remaining_qty = 0;
                return true;
            }
        }
        false
    }

    // ── Matching ─────────────────────────────────────────────────────────────

    /// Incoming order ko resting orders se match karo.
    /// Returns: generated TradeRecords (multiple for partial fills).
    /// `next_trade_id`: caller ka mutable counter, har trade par increment hota hai.
    pub fn match_order(
        &mut self,
        incoming:       &mut Order,
        next_trade_id:  &mut u64,
        timestamp:      u64,
    ) -> Vec<TradeRecord> {
        let mut trades = Vec::new();
        match incoming.side {
            OrderSide::Buy  => self.match_buy(incoming,  next_trade_id, timestamp, &mut trades),
            OrderSide::Sell => self.match_sell(incoming, next_trade_id, timestamp, &mut trades),
        }
        trades
    }

    // ── Private matching logic ───────────────────────────────────────────────

    fn match_buy(
        &mut self,
        buyer:         &mut Order,
        next_trade_id: &mut u64,
        ts:             u64,
        trades:        &mut Vec<TradeRecord>,
    ) {
        while buyer.remaining_qty > 0 {
            let best_ask = match self.best_ask() {
                Some(p) => p,
                None    => break, // no sellers
            };

            // Price check: limit buy matches only if buyer_price >= ask
            let can_match = match buyer.order_type {
                OrderType::Market => true,
                OrderType::Limit  => buyer.price_paise >= best_ask,
            };
            if !can_match { break; }

            let ask_queue = self.asks.get_mut(&best_ask).unwrap();

            // Skip cancelled orders
            while ask_queue.front().map(|o| !o.is_active()).unwrap_or(false) {
                ask_queue.pop_front();
            }
            let seller = match ask_queue.front_mut() {
                Some(o) => o,
                None    => { self.asks.remove(&best_ask); continue; }
            };

            let fill_qty   = buyer.remaining_qty.min(seller.remaining_qty);
            let exec_price = best_ask; // price-time priority: ask price

            trades.push(TradeRecord {
                trade_id:    *next_trade_id,
                symbol:      self.symbol.clone(),
                price_paise: exec_price,
                quantity:    fill_qty,
                timestamp:   ts,
                seq_num:     0, // assigned by Database.insert_trade
                deleted:     false,
            });
            *next_trade_id += 1;

            buyer.remaining_qty  -= fill_qty;
            seller.remaining_qty -= fill_qty;

            if buyer.remaining_qty  == 0 { buyer.status  = OrderStatus::Filled; }
            else                         { buyer.status  = OrderStatus::PartiallyFilled; }

            if seller.remaining_qty == 0 {
                seller.status = OrderStatus::Filled;
                ask_queue.pop_front();
                if ask_queue.is_empty() { self.asks.remove(&best_ask); }
            } else {
                seller.status = OrderStatus::PartiallyFilled;
            }
        }
    }

    fn match_sell(
        &mut self,
        seller:        &mut Order,
        next_trade_id: &mut u64,
        ts:             u64,
        trades:        &mut Vec<TradeRecord>,
    ) {
        while seller.remaining_qty > 0 {
            let best_bid = match self.best_bid() {
                Some(p) => p,
                None    => break, // no buyers
            };

            let can_match = match seller.order_type {
                OrderType::Market => true,
                OrderType::Limit  => seller.price_paise <= best_bid,
            };
            if !can_match { break; }

            let bid_queue = self.bids.get_mut(&best_bid).unwrap();

            while bid_queue.front().map(|o| !o.is_active()).unwrap_or(false) {
                bid_queue.pop_front();
            }
            let buyer = match bid_queue.front_mut() {
                Some(o) => o,
                None    => { self.bids.remove(&best_bid); continue; }
            };

            let fill_qty   = seller.remaining_qty.min(buyer.remaining_qty);
            let exec_price = best_bid;

            trades.push(TradeRecord {
                trade_id:    *next_trade_id,
                symbol:      self.symbol.clone(),
                price_paise: exec_price,
                quantity:    fill_qty,
                timestamp:   ts,
                seq_num:     0,
                deleted:     false,
            });
            *next_trade_id += 1;

            seller.remaining_qty -= fill_qty;
            buyer.remaining_qty  -= fill_qty;

            if seller.remaining_qty == 0 { seller.status = OrderStatus::Filled; }
            else                         { seller.status = OrderStatus::PartiallyFilled; }

            if buyer.remaining_qty == 0 {
                buyer.status = OrderStatus::Filled;
                bid_queue.pop_front();
                if bid_queue.is_empty() { self.bids.remove(&best_bid); }
            } else {
                buyer.status = OrderStatus::PartiallyFilled;
            }
        }
    }
}
