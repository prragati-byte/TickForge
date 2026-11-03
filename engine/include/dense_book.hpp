#pragma once
// Order book for one symbol using a dense array of price levels (one slot per
// cent) instead of a tree. Each level is padded to a 64-byte cache line.
//
// Trade-off: prices must lie in [base, base + num_levels). add() returns false
// for a price outside that range. engine_server uses MapBook, which has no such
// limit; this book is here for the benchmark and the equality tests.
// It has the same interface as MapBook (see map_book.hpp).
#include "types.hpp"
#include <unordered_map>
#include <utility>
#include <vector>

class DenseBook {
public:
  using Levels = std::vector<std::pair<int64_t, uint64_t>>;

  explicit DenseBook(int64_t base = 0, size_t num_levels = 32768)
      : base_(base), n_(num_levels), bids_(num_levels), asks_(num_levels),
        best_bid_(-1), best_ask_(num_levels) {}

  bool add(Order in, uint64_t &next_trade_id, std::vector<Trade> &trades) {
    if (in.price < base_ || in.price >= base_ + static_cast<int64_t>(n_)) return false;
    const int64_t limit = in.price - base_;

    if (in.side == Side::Buy) {
      while (in.qty > 0 && best_ask_ < n_ && static_cast<int64_t>(best_ask_) <= limit) {
        consume(asks_[best_ask_], in, next_trade_id, trades);
        if (asks_[best_ask_].empty()) best_ask_ = next_ask(best_ask_ + 1);
      }
    } else {
      while (in.qty > 0 && best_bid_ >= 0 && best_bid_ >= limit) {
        consume(bids_[best_bid_], in, next_trade_id, trades);
        if (bids_[best_bid_].empty()) best_bid_ = next_bid(best_bid_ - 1);
      }
    }

    if (in.qty > 0) {
      if (in.side == Side::Buy) {
        bids_[limit].push(in);
        if (limit > best_bid_) best_bid_ = limit;
      } else {
        asks_[limit].push(in);
        if (static_cast<size_t>(limit) < best_ask_) best_ask_ = limit;
      }
      where_[in.order_id] = {in.price, in.side};
    }
    return true;
  }

  bool cancel(uint64_t order_id) {
    auto it = where_.find(order_id);
    if (it == where_.end()) return false;
    auto [price, side] = it->second;
    const size_t idx = price - base_;
    if (side == Side::Buy) {
      bids_[idx].remove(order_id);
      if (static_cast<int64_t>(idx) == best_bid_ && bids_[idx].empty())
        best_bid_ = next_bid(best_bid_ - 1);
    } else {
      asks_[idx].remove(order_id);
      if (idx == best_ask_ && asks_[idx].empty()) best_ask_ = next_ask(best_ask_ + 1);
    }
    where_.erase(it);
    return true;
  }

  void levels(Side side, size_t depth, Levels &out) const {
    if (side == Side::Buy) {
      for (int64_t i = best_bid_; i >= 0 && out.size() < depth; i--)
        if (!bids_[i].empty()) out.emplace_back(base_ + i, bids_[i].total);
    } else {
      for (size_t i = best_ask_; i < n_ && out.size() < depth; i++)
        if (!asks_[i].empty()) out.emplace_back(base_ + i, asks_[i].total);
    }
  }

  template <class F> void for_each(F f) const {
    for (int64_t i = best_bid_; i >= 0; i--)
      bids_[i].for_each([&](const Order &o) { f(o.order_id, base_ + i, o.qty); });
    for (size_t i = best_ask_; i < n_; i++)
      asks_[i].for_each([&](const Order &o) { f(o.order_id, base_ + (int64_t)i, o.qty); });
  }

private:
  // FIFO of resting orders at one price. `head` skips orders already filled.
  struct alignas(64) Level {
    std::vector<Order> orders;
    size_t head = 0;
    uint64_t total = 0; // sum of remaining qty

    bool empty() const { return head == orders.size(); }
    Order &front() { return orders[head]; }
    void push(const Order &o) {
      orders.push_back(o);
      total += o.qty;
    }
    void pop_front() {
      head++;
      if (empty()) {
        orders.clear();
        head = 0;
      } else if (head >= 64 && head * 2 >= orders.size()) {
        // Drop the filled prefix so a busy level does not grow forever.
        orders.erase(orders.begin(), orders.begin() + head);
        head = 0;
      }
    }
    void remove(uint64_t order_id) {
      for (size_t i = head; i < orders.size(); i++) {
        if (orders[i].order_id == order_id) {
          total -= orders[i].qty;
          orders.erase(orders.begin() + i);
          break;
        }
      }
      if (empty()) {
        orders.clear();
        head = 0;
      }
    }
    template <class F> void for_each(F f) const {
      for (size_t i = head; i < orders.size(); i++) f(orders[i]);
    }
  };

  void consume(Level &level, Order &in, uint64_t &next_trade_id, std::vector<Trade> &trades) {
    while (in.qty > 0 && !level.empty()) {
      Order &resting = level.front();
      trades.push_back(fill(next_trade_id++, in, resting));
      level.total -= trades.back().qty;
      if (resting.qty == 0) {
        where_.erase(resting.order_id);
        level.pop_front();
      }
    }
  }

  size_t next_ask(size_t from) const {
    while (from < n_ && asks_[from].empty()) from++;
    return from;
  }
  int64_t next_bid(int64_t from) const {
    while (from >= 0 && bids_[from].empty()) from--;
    return from;
  }

  int64_t base_;
  size_t n_;
  std::vector<Level> bids_;
  std::vector<Level> asks_;
  int64_t best_bid_; // index of the highest bid level, -1 if none
  size_t best_ask_;  // index of the lowest ask level, n_ if none
  std::unordered_map<uint64_t, std::pair<int64_t, Side>> where_;
};
