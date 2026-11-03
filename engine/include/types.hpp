#pragma once
// Plain data types shared by the whole engine.
// Prices are integer cents, times are milliseconds since the Unix epoch.
#include <algorithm>
#include <cstdint>

enum class Side : uint8_t { Buy = 0, Sell = 1 };

// Valid symbol ids are 1..MAX_SYMBOL_ID.
constexpr uint32_t MAX_SYMBOL_ID = 1000;

struct Order {
  uint64_t order_id = 0; // equals seq
  uint64_t seq = 0;
  uint64_t ts_ms = 0;
  uint32_t symbol_id = 0;
  Side side = Side::Buy;
  int64_t price = 0;
  uint32_t qty = 0; // remaining quantity once the order rests
};

struct Trade {
  uint64_t trade_id = 0;
  uint64_t seq = 0; // seq of the input that caused the trade (the taker)
  uint32_t symbol_id = 0;
  int64_t price = 0; // price of the resting order
  uint32_t qty = 0;
  uint64_t buy_order_id = 0;
  uint64_t sell_order_id = 0;
  Side taker_side = Side::Buy;
  uint64_t ts_ms = 0;
};

// Build a trade between an incoming order and a resting order.
// Reduces both orders by the traded quantity.
inline Trade fill(uint64_t trade_id, Order &taker, Order &resting) {
  Trade t;
  t.trade_id = trade_id;
  t.seq = taker.seq;
  t.symbol_id = taker.symbol_id;
  t.price = resting.price;
  t.qty = std::min(taker.qty, resting.qty);
  t.buy_order_id = taker.side == Side::Buy ? taker.order_id : resting.order_id;
  t.sell_order_id = taker.side == Side::Buy ? resting.order_id : taker.order_id;
  t.taker_side = taker.side;
  t.ts_ms = taker.ts_ms;
  taker.qty -= t.qty;
  resting.qty -= t.qty;
  return t;
}
