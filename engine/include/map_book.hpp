#pragma once
// Order book for one symbol, built on std::map. This is the baseline book and
// the one engine_server uses: it accepts any price.
//
// Book interface (MapBook and DenseBook both have it):
//   bool add(Order, next_trade_id, trades)   match, then rest the remainder
//   bool cancel(order_id)                    false if the order is not resting
//   void levels(side, depth, out)            [price, total qty], best first
//   void for_each(f)                         f(order_id, price, qty): bids best
//                                            first, then asks best first
#include "types.hpp"
#include <deque>
#include <functional>
#include <map>
#include <unordered_map>
#include <utility>
#include <vector>

class MapBook {
public:
  using Levels = std::vector<std::pair<int64_t, uint64_t>>;

  bool add(Order in, uint64_t &next_trade_id, std::vector<Trade> &trades) {
    if (in.side == Side::Buy)
      take(asks_, in, next_trade_id, trades, [&](int64_t p) { return p <= in.price; });
    else
      take(bids_, in, next_trade_id, trades, [&](int64_t p) { return p >= in.price; });

    if (in.qty > 0) {
      if (in.side == Side::Buy) bids_[in.price].push_back(in);
      else asks_[in.price].push_back(in);
      where_[in.order_id] = {in.price, in.side};
    }
    return true;
  }

  bool cancel(uint64_t order_id) {
    auto it = where_.find(order_id);
    if (it == where_.end()) return false;
    auto [price, side] = it->second;
    if (side == Side::Buy) erase_from(bids_, price, order_id);
    else erase_from(asks_, price, order_id);
    where_.erase(it);
    return true;
  }

  void levels(Side side, size_t depth, Levels &out) const {
    if (side == Side::Buy) collect(bids_, depth, out);
    else collect(asks_, depth, out);
  }

  template <class F> void for_each(F f) const {
    for (const auto &[price, q] : bids_)
      for (const Order &o : q) f(o.order_id, price, o.qty);
    for (const auto &[price, q] : asks_)
      for (const Order &o : q) f(o.order_id, price, o.qty);
  }

private:
  using Queue = std::deque<Order>;

  // Match `in` against one side of the book while the prices cross.
  template <class Map, class Crosses>
  void take(Map &side, Order &in, uint64_t &next_trade_id, std::vector<Trade> &trades,
            Crosses crosses) {
    while (in.qty > 0 && !side.empty()) {
      auto level = side.begin();
      if (!crosses(level->first)) break;
      Queue &q = level->second;
      while (in.qty > 0 && !q.empty()) {
        trades.push_back(fill(next_trade_id++, in, q.front()));
        if (q.front().qty == 0) {
          where_.erase(q.front().order_id);
          q.pop_front();
        }
      }
      if (q.empty()) side.erase(level);
    }
  }

  template <class Map> static void erase_from(Map &side, int64_t price, uint64_t order_id) {
    auto level = side.find(price);
    Queue &q = level->second;
    for (auto it = q.begin(); it != q.end(); ++it) {
      if (it->order_id == order_id) {
        q.erase(it);
        break;
      }
    }
    if (q.empty()) side.erase(level);
  }

  template <class Map> static void collect(const Map &side, size_t depth, Levels &out) {
    for (const auto &[price, q] : side) {
      if (out.size() >= depth) break;
      uint64_t total = 0;
      for (const Order &o : q) total += o.qty;
      out.emplace_back(price, total);
    }
  }

  std::map<int64_t, Queue, std::greater<int64_t>> bids_; // highest price first
  std::map<int64_t, Queue> asks_;                        // lowest price first
  std::unordered_map<uint64_t, std::pair<int64_t, Side>> where_; // order_id -> price, side
};
