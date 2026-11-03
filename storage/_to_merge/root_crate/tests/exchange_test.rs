// Exchange / Matching Engine Tests
//
// Covers:
//   - Limit order: no match → stays in book
//   - Limit buy + sell → trade generated
//   - Partial fill → correct qty tracking
//   - Market order → immediate match at best price
//   - Order cancellation → cancelled order not matched
//   - Best bid/ask tracking
//   - Spread calculation
//   - Generated trades → Database integration
//   - Price-time priority (FIFO at same price)
//   - Multiple symbols in same engine

use tickforge_db::database::Database;
use tickforge_db::exchange::MatchingEngine;

fn ts(n: u64) -> u64 { 1_700_000_000 + n }

// ── Basic Matching ────────────────────────────────────────────────────────────

#[test]
fn limit_sell_no_buyer_stays_in_book() {
    let mut e = MatchingEngine::new();
    let trades = e.limit_sell("TCS", 350_000, 10, ts(1)).unwrap();
    assert!(trades.is_empty(), "No buyer → no trade");
    assert_eq!(e.best_ask("TCS"), Some(350_000));
    assert_eq!(e.open_orders("TCS"), 1);
}

#[test]
fn limit_buy_no_seller_stays_in_book() {
    let mut e = MatchingEngine::new();
    let trades = e.limit_buy("INFY", 145_000, 5, ts(1)).unwrap();
    assert!(trades.is_empty());
    assert_eq!(e.best_bid("INFY"), Some(145_000));
    assert_eq!(e.open_orders("INFY"), 1);
}

#[test]
fn limit_buy_and_sell_match() {
    let mut e = MatchingEngine::new();
    e.limit_sell("TCS", 350_000, 10, ts(1)).unwrap();
    let trades = e.limit_buy("TCS", 350_000, 10, ts(2)).unwrap();
    assert_eq!(trades.len(), 1);
    assert_eq!(trades[0].quantity, 10);
    assert_eq!(trades[0].price_paise, 350_000);
    assert_eq!(trades[0].symbol, "TCS");
    // Book should be empty after full match
    assert_eq!(e.open_orders("TCS"), 0);
}

#[test]
fn buy_price_above_ask_matches() {
    let mut e = MatchingEngine::new();
    e.limit_sell("RELIANCE", 240_000, 5, ts(1)).unwrap();
    // Buyer willing to pay more than ask
    let trades = e.limit_buy("RELIANCE", 250_000, 5, ts(2)).unwrap();
    assert_eq!(trades.len(), 1);
    // Execution at ask price (seller's price wins)
    assert_eq!(trades[0].price_paise, 240_000);
}

#[test]
fn buy_price_below_ask_no_match() {
    let mut e = MatchingEngine::new();
    e.limit_sell("WIPRO", 55_000, 10, ts(1)).unwrap();
    let trades = e.limit_buy("WIPRO", 50_000, 10, ts(2)).unwrap();
    assert!(trades.is_empty(), "Buy price < ask price → no match");
    assert_eq!(e.open_orders("WIPRO"), 2); // both in book
}

// ── Partial Fills ─────────────────────────────────────────────────────────────

#[test]
fn partial_fill_buyer_larger() {
    let mut e = MatchingEngine::new();
    e.limit_sell("HDFC", 165_000, 5, ts(1)).unwrap(); // seller: qty 5
    let trades = e.limit_buy("HDFC", 165_000, 10, ts(2)).unwrap(); // buyer: qty 10
    assert_eq!(trades.len(), 1);
    assert_eq!(trades[0].quantity, 5); // only 5 filled
    // Buyer remainder (5) should stay in book
    assert_eq!(e.best_bid("HDFC"), Some(165_000));
    assert_eq!(e.open_orders("HDFC"), 1);
}

#[test]
fn partial_fill_seller_larger() {
    let mut e = MatchingEngine::new();
    e.limit_sell("HDFC", 165_000, 20, ts(1)).unwrap(); // seller: qty 20
    let trades = e.limit_buy("HDFC", 165_000, 8, ts(2)).unwrap();  // buyer: qty 8
    assert_eq!(trades.len(), 1);
    assert_eq!(trades[0].quantity, 8);
    // Seller remainder (12) stays in book
    assert_eq!(e.best_ask("HDFC"), Some(165_000));
}

#[test]
fn multiple_trades_from_one_order() {
    let mut e = MatchingEngine::new();
    // Three small sellers at same price
    e.limit_sell("X", 100_000, 3, ts(1)).unwrap();
    e.limit_sell("X", 100_000, 3, ts(2)).unwrap();
    e.limit_sell("X", 100_000, 3, ts(3)).unwrap();
    // One big buyer
    let trades = e.limit_buy("X", 100_000, 9, ts(4)).unwrap();
    assert_eq!(trades.len(), 3, "Should generate 3 separate trades (one per seller)");
    let total_qty: u64 = trades.iter().map(|t| t.quantity).sum();
    assert_eq!(total_qty, 9);
}

// ── Market Orders ─────────────────────────────────────────────────────────────

#[test]
fn market_buy_matches_best_ask() {
    let mut e = MatchingEngine::new();
    e.limit_sell("TCS", 355_000, 10, ts(1)).unwrap();
    e.limit_sell("TCS", 350_000,  5, ts(2)).unwrap(); // cheaper → best ask
    let trades = e.market_buy("TCS", 5, ts(3)).unwrap();
    assert_eq!(trades.len(), 1);
    assert_eq!(trades[0].price_paise, 350_000, "Market buy should match at best ask");
    assert_eq!(trades[0].quantity, 5);
}

#[test]
fn market_sell_matches_best_bid() {
    let mut e = MatchingEngine::new();
    e.limit_buy("INFY", 140_000, 10, ts(1)).unwrap();
    e.limit_buy("INFY", 145_000,  5, ts(2)).unwrap(); // higher → best bid
    let trades = e.market_sell("INFY", 5, ts(3)).unwrap();
    assert_eq!(trades.len(), 1);
    assert_eq!(trades[0].price_paise, 145_000, "Market sell at best bid");
}

#[test]
fn market_order_no_liquidity_generates_no_trades() {
    let mut e = MatchingEngine::new();
    let trades = e.market_buy("WIPRO", 10, ts(1)).unwrap();
    assert!(trades.is_empty(), "Empty book → no trades");
}

// ── Order Cancellation ────────────────────────────────────────────────────────

#[test]
fn cancelled_order_not_matched() {
    let mut e = MatchingEngine::new();
    // Place a sell order and get its id
    e.limit_sell("TCS", 350_000, 10, ts(1)).unwrap();
    let order_id = e.next_order_id - 1; // last assigned id
    let cancelled = e.cancel_order("TCS", order_id);
    assert!(cancelled, "Order should be found and cancelled");

    // Now buy at same price → no match (seller cancelled)
    let trades = e.limit_buy("TCS", 350_000, 10, ts(2)).unwrap();
    assert!(trades.is_empty(), "Cancelled order must not match");
}

// ── Price-Time Priority ───────────────────────────────────────────────────────

#[test]
fn price_time_priority_fifo_at_same_price() {
    let mut e = MatchingEngine::new();
    // Two sellers at same price — FIFO: first placed should match first
    e.limit_sell("RELIANCE", 240_000, 5, ts(1)).unwrap(); // id 1, first
    e.limit_sell("RELIANCE", 240_000, 5, ts(2)).unwrap(); // id 2, second

    let trades = e.limit_buy("RELIANCE", 240_000, 5, ts(3)).unwrap();
    assert_eq!(trades.len(), 1);
    // Only 5 units matched (from first seller)
    assert_eq!(trades[0].quantity, 5);
    // Second seller still open
    assert_eq!(e.best_ask("RELIANCE"), Some(240_000));
    assert_eq!(e.open_orders("RELIANCE"), 1);
}

// ── Spread ────────────────────────────────────────────────────────────────────

#[test]
fn spread_calculated_correctly() {
    let mut e = MatchingEngine::new();
    e.limit_buy("TCS",  349_000, 5, ts(1)).unwrap();
    e.limit_sell("TCS", 351_000, 5, ts(2)).unwrap();
    assert_eq!(e.spread("TCS"), Some(2_000), "Spread = ask - bid = 2000 paise");
}

#[test]
fn spread_none_when_one_side_empty() {
    let mut e = MatchingEngine::new();
    e.limit_buy("INFY", 145_000, 5, ts(1)).unwrap();
    assert_eq!(e.spread("INFY"), None, "No ask side → spread undefined");
}

// ── Multiple Symbols ──────────────────────────────────────────────────────────

#[test]
fn multiple_symbols_isolated() {
    let mut e = MatchingEngine::new();
    e.limit_sell("TCS",  350_000, 10, ts(1)).unwrap();
    e.limit_sell("INFY", 145_000, 10, ts(2)).unwrap();

    let tcs_trades  = e.limit_buy("TCS",  350_000, 10, ts(3)).unwrap();
    let infy_trades = e.limit_buy("INFY", 145_000, 10, ts(4)).unwrap();

    assert_eq!(tcs_trades.len(),  1);
    assert_eq!(infy_trades.len(), 1);
    assert_eq!(tcs_trades[0].symbol,  "TCS");
    assert_eq!(infy_trades[0].symbol, "INFY");
}

// ── Database Integration ──────────────────────────────────────────────────────

#[test]
fn matched_trades_persist_to_database() {
    let dir  = tempfile::tempdir().unwrap();
    let path = dir.path().join("wal.log").to_string_lossy().to_string();
    let mut db     = Database::open(&path).unwrap();
    let mut engine = MatchingEngine::new();

    engine.limit_sell("WIPRO", 53_000, 20, ts(1)).unwrap();
    let trades = engine.limit_buy("WIPRO", 53_000, 15, ts(2)).unwrap();
    assert_eq!(trades.len(), 1);

    for t in trades {
        db.insert_trade(t).unwrap();
    }

    // Trade must be queryable from DB
    let r = db.query().by_symbol("WIPRO").unwrap();
    assert_eq!(r.trades.len(), 1);
    assert_eq!(r.trades[0].quantity, 15);
    assert_eq!(r.trades[0].price_paise, 53_000);
}

#[test]
fn trades_survive_restart_after_exchange() {
    let dir  = tempfile::tempdir().unwrap();
    let path = dir.path().join("wal.log").to_string_lossy().to_string();

    {
        let mut db     = Database::open(&path).unwrap();
        let mut engine = MatchingEngine::new();
        engine.limit_sell("HDFC", 165_000, 10, ts(1)).unwrap();
        let trades = engine.limit_buy("HDFC", 165_000, 10, ts(2)).unwrap();
        for t in trades { db.insert_trade(t).unwrap(); }
    }

    // Restart
    let db = Database::open(&path).unwrap();
    let r  = db.query().by_symbol("HDFC").unwrap();
    assert_eq!(r.trades.len(), 1, "Trade must survive DB restart");
}
