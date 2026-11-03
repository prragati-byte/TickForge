#include "matching_engine.hpp"
#include <atomic>
#include <chrono>
#include <iostream>
#include <random>
#include <thread>
#include <vector>

void producer_thread(MatchingEngine &engine, int thread_id, int num_orders,
                     std::atomic<uint64_t> &order_id_counter) {
  std::mt19937 rng(thread_id);
  std::uniform_real_distribution<double> price_dist(140.0, 160.0);
  std::uniform_int_distribution<uint32_t> qty_dist(1, 500);
  std::uniform_int_distribution<int> side_dist(0, 1);

  for (int i = 0; i < num_orders; i++) {
    Order o;
    o.order_id = order_id_counter.fetch_add(1, std::memory_order_relaxed);
    o.symbol_id = 1;
    o.side = side_dist(rng) == 0 ? Side::BUY : Side::SELL;
    o.price = price_dist(rng);
    o.quantity = qty_dist(rng);
    o.seq = o.order_id;
    engine.submit(o);
  }
}

int main() {
  MatchingEngine engine;
  std::atomic<uint64_t> trades_seen{0};

  engine.set_trade_callback([&](const Trade &t) {
    trades_seen.fetch_add(1, std::memory_order_relaxed);
    std::cout << "TRADE id=" << t.trade_id << " price=" << t.price
              << " qty=" << t.quantity << " buy=" << t.buy_order_id
              << " sell=" << t.sell_order_id << "\n";
  });

  std::thread matcher([&]() { engine.run(); });

  std::atomic<uint64_t> order_id_counter{1};
  const int num_producers = 4;
  const int orders_per_producer = 1000;

  std::vector<std::thread> producers;
  auto start = std::chrono::high_resolution_clock::now();

  for (int i = 0; i < num_producers; i++) {
    producers.emplace_back(producer_thread, std::ref(engine), i,
                           orders_per_producer, std::ref(order_id_counter));
  }

  for (auto &p : producers) {
    p.join();
  }

  std::this_thread::sleep_for(std::chrono::milliseconds(500));

  auto end = std::chrono::high_resolution_clock::now();

  engine.stop();
  matcher.join();

  double elapsed_ms =
      std::chrono::duration<double, std::milli>(end - start).count();
  std::cout << "\nTotal trades: " << trades_seen.load() << "\n";
  std::cout << "Elapsed: " << elapsed_ms << " ms\n";

  return 0;
}
