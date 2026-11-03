#pragma once
// All order books plus the counters that make up the engine state.
// No threads and no I/O here: the matching thread and WAL recovery both feed
// it the same inputs in the same order, so they end in the same state.
#include "types.hpp"
#include <atomic>
#include <map>
#include <vector>

template <class Book> class Exchange {
public:
  Exchange() {
    for (auto &p : last_price_) p.store(0, std::memory_order_relaxed);
  }

  // Match a new order. Trades are appended to `trades`.
  void new_order(const Order &order, std::vector<Trade> &trades) {
    last_seq_ = order.seq;
    size_t before = trades.size();
    books_[order.symbol_id].add(order, next_trade_id_, trades);
    if (trades.size() > before)
      last_price_[order.symbol_id].store(trades.back().price, std::memory_order_relaxed);
  }

  // Returns false if the order is not resting (never existed or already filled).
  bool cancel(uint64_t seq, uint64_t order_id) {
    last_seq_ = seq;
    for (auto &entry : books_)
      if (entry.second.cancel(order_id)) return true;
    return false;
  }

  const Book *book(uint32_t symbol_id) const {
    auto it = books_.find(symbol_id);
    return it == books_.end() ? nullptr : &it->second;
  }

  uint64_t last_seq() const { return last_seq_; }
  uint64_t trades_total() const { return next_trade_id_ - 1; }

  // Price of the last trade in a symbol, 0 if none. Safe to call from any thread.
  int64_t last_price(uint32_t symbol_id) const {
    return last_price_[symbol_id].load(std::memory_order_relaxed);
  }

  // FNV-1a 64 over last_seq, next trade id, then every resting order
  // (symbols ascending, bids then asks, FIFO within a price).
  uint64_t state_hash() const {
    uint64_t h = 0xcbf29ce484222325ULL;
    auto feed = [&h](uint64_t v) {
      for (int i = 0; i < 8; i++) {
        h ^= (v >> (8 * i)) & 0xff;
        h *= 0x100000001b3ULL;
      }
    };
    feed(last_seq_);
    feed(next_trade_id_);
    for (const auto &entry : books_)
      entry.second.for_each([&](uint64_t id, int64_t price, uint32_t qty) {
        feed(id);
        feed(static_cast<uint64_t>(price));
        feed(qty);
      });
    return h;
  }

private:
  std::map<uint32_t, Book> books_; // ascending symbol id
  uint64_t last_seq_ = 0;
  uint64_t next_trade_id_ = 1;
  std::atomic<int64_t> last_price_[MAX_SYMBOL_ID + 1];
};
