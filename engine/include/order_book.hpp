#pragma once
#include "order.hpp"
#include <deque>
#include <map>
#include <vector>
#include <utility>  // std::pair

class OrderBook {
private:
  // Buy levels: highest price first (descending)
  std::map<double, std::deque<Order>, std::greater<double>> buy_levels_;
  // Sell levels: lowest price first (ascending)
  std::map<double, std::deque<Order>> sell_levels_;

public:
  void insert_resting(const Order &order);

  std::vector<Trade> match(Order incoming, uint64_t &trade_counter);

  // Return best bid and best ask prices (0.0 if side is empty)
  std::pair<double, double> best_bid_ask() const {
    double bid = buy_levels_.empty()  ? 0.0 : buy_levels_.begin()->first;
    double ask = sell_levels_.empty() ? 0.0 : sell_levels_.begin()->first;
    return {bid, ask};
  }

  // Check if both sides have resting orders
  bool has_resting() const {
    return !buy_levels_.empty() || !sell_levels_.empty();
  }
};
