#pragma once
#include <cstdint>

enum class Side { BUY, SELL };

struct Order {
  uint64_t order_id;
  uint64_t symbol_id;
  Side side;
  double price;
  uint32_t quantity;
  uint64_t seq;
};

struct Trade {
  uint64_t trade_id;
  uint64_t symbol_id;
  double price;
  uint32_t quantity;
  uint64_t buy_order_id;
  uint64_t sell_order_id;
};
