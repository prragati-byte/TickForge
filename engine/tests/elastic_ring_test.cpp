// Stress test for ElasticRing. Also built with ThreadSanitizer and AddressSanitizer
// (see CMakeLists.txt).
//
// Every item is (producer number, counter). The consumer checks that
//   - nothing is lost or duplicated,
//   - items from one producer come out in the order they went in,
//   - the slow path really ran, where a case is meant to force it,
//   - with one producer the order is exactly FIFO across ring and overflow.
#include "elastic_ring.hpp"
#include "exchange.hpp"
#include "map_book.hpp"
#include "test_util.hpp"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <random>
#include <string>
#include <thread>
#include <vector>

// A value that does not fit in one machine word, so a torn read would show up.
struct Item {
  uint64_t a = 0;
  uint64_t b = 0;
};

static Item make_item(uint64_t producer, uint64_t i) {
  Item it;
  it.a = (producer << 32) | i;
  it.b = ~it.a;
  return it;
}

// `pause_every`: the consumer naps after that many items, so the ring fills up.
static void run_case(const char *name, size_t ring, int producers, int per_producer, int pause_every,
                     bool expect_overflow) {
  ElasticRing<Item> q(ring);
  const uint64_t total = static_cast<uint64_t>(producers) * per_producer;
  std::vector<uint64_t> next_expected(producers, 0);
  uint64_t consumed = 0;
  bool ok = true;
  auto t0 = std::chrono::steady_clock::now();

  std::thread consumer([&] {
    while (consumed < total) {
      Item v;
      if (!q.dequeue(v)) {
        std::this_thread::yield();
        continue;
      }
      uint64_t p = v.a >> 32, i = v.a & 0xffffffffu;
      if (v.b != ~v.a || p >= static_cast<uint64_t>(producers) || next_expected[p] != i) ok = false;
      else next_expected[p]++;
      consumed++;
      if (pause_every > 0 && consumed % pause_every == 0)
        std::this_thread::sleep_for(std::chrono::microseconds(200));
    }
  });

  std::vector<std::thread> threads;
  for (int p = 0; p < producers; p++)
    threads.emplace_back([&q, p, per_producer] {
      for (int i = 0; i < per_producer; i++) q.enqueue(make_item(p, i));
    });
  for (auto &t : threads) t.join();
  consumer.join();

  Item extra;
  CHECK(!q.dequeue(extra));
  CHECK(ok);
  CHECK(consumed == total);
  CHECK(q.depth() == 0);
  if (expect_overflow) CHECK(q.overflowed_total() > 0);

  double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  std::cout << "  " << name << ": " << (ok && consumed == total ? "ok" : "FAILED") << ", overflowed "
            << q.overflowed_total() << " of " << total << ", " << ms << " ms\n";
}

// One producer, no consumer yet: everything past the ring must go to overflow,
// then come out in exact order. Repeated, so the ring is reused after each burst.
static void test_exact_order_across_both_sides() {
  ElasticRing<uint64_t> q(8);
  CHECK(q.capacity() == 8);
  uint64_t in = 0, out = 0;
  for (int round = 0; round < 50; round++) {
    const int burst = 1 + round * 3; // from well inside the ring to well past it
    for (int i = 0; i < burst; i++) q.enqueue(in++);
    CHECK(q.depth() == static_cast<uint64_t>(burst));
    for (int i = 0; i < burst; i++) {
      uint64_t v = 0;
      CHECK(q.dequeue(v));
      CHECK(v == out);
      out++;
    }
    uint64_t none;
    CHECK(!q.dequeue(none));
  }
  CHECK(q.overflowed_total() > 0);

  // Back to normal: after every burst, a short flow must not need overflow.
  uint64_t before = q.overflowed_total();
  for (int i = 0; i < 1000; i++) {
    q.enqueue(in++);
    uint64_t v = 0;
    CHECK(q.dequeue(v));
    CHECK(v == out);
    out++;
  }
  CHECK(q.overflowed_total() == before);
}

// Dequeuing and enqueuing at the same time at the exact moment the ring is full.
static void test_small_ring_interleaved() {
  ElasticRing<uint64_t> q(2);
  uint64_t in = 0, out = 0;
  for (int i = 0; i < 20000; i++) {
    for (int k = 0; k < 1 + i % 5; k++) q.enqueue(in++);
    for (int k = 0; k < 1 + (i * 7) % 5 && out < in; k++) {
      uint64_t v = 0;
      CHECK(q.dequeue(v));
      CHECK(v == out);
      out++;
    }
  }
  while (out < in) {
    uint64_t v = 0;
    CHECK(q.dequeue(v));
    CHECK(v == out);
    out++;
  }
  CHECK(q.depth() == 0);
}

// Items still inside when the queue is destroyed must be freed (ASan finds leaks).
static void test_destroy_with_items_left() {
  ElasticRing<std::string> q(4);
  for (int i = 0; i < 100; i++) q.enqueue("a string too long for the small-string buffer " + std::to_string(i));
  std::string v;
  CHECK(q.dequeue(v));
  CHECK(v.rfind("a string", 0) == 0);
}

// Far more threads over time than the lock-free queue's limit of 128 at once.
static void test_many_short_lived_threads() {
  ElasticRing<uint64_t> q(64);
  const int threads = 400, per_thread = 200;
  std::atomic<uint64_t> sum_in{0};
  uint64_t sum_out = 0, got = 0;
  std::thread consumer([&] {
    while (got < static_cast<uint64_t>(threads) * per_thread) {
      uint64_t v;
      if (q.dequeue(v)) {
        sum_out += v;
        got++;
      } else {
        std::this_thread::yield();
      }
    }
  });
  for (int start = 0; start < threads; start += 40) {
    std::vector<std::thread> batch;
    for (int t = start; t < start + 40; t++)
      batch.emplace_back([&q, &sum_in, t] {
        for (int i = 0; i < per_thread; i++) {
          uint64_t v = static_cast<uint64_t>(t) * 1000 + i;
          q.enqueue(v);
          sum_in.fetch_add(v, std::memory_order_relaxed);
        }
      });
    for (auto &t : batch) t.join();
  }
  consumer.join();
  CHECK(sum_in.load() == sum_out);
}

// Orders through the queue must match exactly like the same orders with no queue,
// even when a tiny ring sends most of them through overflow.
static void test_matching_gives_the_same_state() {
  std::vector<Order> orders;
  std::mt19937 rng(11);
  for (uint64_t i = 1; i <= 50000; i++) {
    Order o;
    o.order_id = o.seq = i;
    o.symbol_id = 1 + rng() % 3;
    o.side = rng() % 2 ? Side::Buy : Side::Sell;
    o.price = 9900 + rng() % 200;
    o.qty = 1 + rng() % 100;
    orders.push_back(o);
  }

  Exchange<MapBook> direct;
  std::vector<Trade> direct_trades;
  for (const Order &o : orders) direct.new_order(o, direct_trades);

  for (size_t ring : {size_t{2}, size_t{64}, size_t{1} << 17}) {
    ElasticRing<Order> q(ring);
    std::thread producer([&] {
      for (const Order &o : orders) q.enqueue(o);
    });
    Exchange<MapBook> queued;
    std::vector<Trade> trades;
    for (size_t got = 0; got < orders.size();) {
      Order o;
      if (!q.dequeue(o)) {
        std::this_thread::yield();
        continue;
      }
      queued.new_order(o, trades);
      got++;
    }
    producer.join();
    CHECK(queued.state_hash() == direct.state_hash());
    CHECK(trades.size() == direct_trades.size());
  }
}

int main() {
  test_matching_gives_the_same_state();
  test_exact_order_across_both_sides();
  test_small_ring_interleaved();
  test_destroy_with_items_left();
  test_many_short_lived_threads();
  run_case("8 producers, ring big enough", 1 << 18, 8, 20000, 0, false);
  run_case("8 producers, tiny ring", 4, 8, 20000, 0, true);
  run_case("8 producers, slow consumer", 256, 8, 20000, 500, true);
  run_case("1 producer, long run", 64, 1, 200000, 2000, true);
  run_case("32 producers, tiny ring", 2, 32, 2000, 0, true);
  return finish("elastic_ring_test");
}
