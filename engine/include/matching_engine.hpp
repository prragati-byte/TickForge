#pragma once
// matching_engine.hpp — one OrderBook per symbol, WAL integration

#include "lock_free_queue.hpp"
#include "order_book.hpp"
#include <atomic>
#include <functional>
#include <thread>
#include <unordered_map>
#include <vector>

class MatchingEngine {
private:
  MPSCQueue<Order>   queue_;
  // Key: symbol_id → one book per symbol (e.g. AAPL=1, GOOG=2, …)
  std::unordered_map<uint64_t, OrderBook> books_;
  std::atomic<bool>  running_;
  uint64_t           trade_counter_;
  std::function<void(const Trade &)> on_trade_;

  OrderBook &book_for(uint64_t symbol_id) {
    return books_[symbol_id]; // default-constructs if absent
  }

public:
  MatchingEngine() : running_(false), trade_counter_(0) {}

  void set_trade_callback(std::function<void(const Trade &)> cb) {
    on_trade_ = std::move(cb);
  }

  void submit(const Order &order) { queue_.enqueue(order); }

  void run() {
    running_.store(true, std::memory_order_release);
    while (running_.load(std::memory_order_acquire)) {
      Order order;
      if (queue_.dequeue(order)) {
        auto &book  = book_for(order.symbol_id);
        auto trades = book.match(order, trade_counter_);
        for (const auto &t : trades) {
          if (on_trade_) on_trade_(t);
        }
      } else {
        std::this_thread::yield();
      }
    }
    // Drain any remaining orders in the queue after stop() is called
    Order order;
    while (queue_.dequeue(order)) {
      auto &book  = book_for(order.symbol_id);
      auto trades = book.match(order, trade_counter_);
      for (const auto &t : trades) {
        if (on_trade_) on_trade_(t);
      }
    }
  }

  void stop() { running_.store(false, std::memory_order_release); }

  // Returns current best bid/ask for a symbol (for order book snapshot)
  std::pair<double, double> best_bid_ask(uint64_t symbol_id) {
    auto it = books_.find(symbol_id);
    if (it == books_.end()) return {0.0, 0.0};
    return it->second.best_bid_ask();
  }

  // Seed resting orders replayed from WAL (crash recovery)
  void restore_resting(const Order &order) {
    book_for(order.symbol_id).insert_resting(order);
  }
};
