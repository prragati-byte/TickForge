// Benchmarks. Output is markdown, so it can be pasted into docs:
//   ./engine_bench > last_run.md
//
// 1. Queue: MPSCQueue (lock-free) vs std::mutex + std::deque, many producers
//    and one consumer. Reports throughput (items handed over per second) and
//    how long the producer spends inside enqueue() (P50 / P99).
// 2. Book: MapBook (std::map) vs DenseBook (array of cache-line levels), same
//    stream of orders. Reports throughput and time per add() call (P50 / P99).
//
// Per-call times are taken with steady_clock around each call. That clock read
// costs roughly 20-30 ns itself, so small numbers include that overhead.
#include "dense_book.hpp"
#include "lock_free_queue.hpp"
#include "map_book.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <deque>
#include <fstream>
#include <iostream>
#include <mutex>
#include <random>
#include <string>
#include <thread>
#include <vector>

using Clock = std::chrono::steady_clock;

static int64_t ns_since(Clock::time_point t0) {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - t0).count();
}

static int64_t percentile(std::vector<int64_t> &v, double p) {
  if (v.empty()) return 0;
  size_t i = std::min(v.size() - 1, static_cast<size_t>(v.size() * p));
  std::nth_element(v.begin(), v.begin() + i, v.end());
  return v[i];
}

static std::string fixed(double x, int digits) {
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%.*f", digits, x);
  return buf;
}

// ---- 1. queues -----------------------------------------------------------------

struct MutexQueue {
  std::mutex mu;
  std::deque<uint64_t> q;
  void enqueue(uint64_t v) {
    std::lock_guard<std::mutex> g(mu);
    q.push_back(v);
  }
  bool dequeue(uint64_t &out) {
    std::lock_guard<std::mutex> g(mu);
    if (q.empty()) return false;
    out = q.front();
    q.pop_front();
    return true;
  }
};

struct QueueResult {
  double mops;
  int64_t p50_ns, p99_ns;
};

template <class Q> QueueResult bench_queue(int producers, int per_producer) {
  Q q;
  const uint64_t total = static_cast<uint64_t>(producers) * per_producer;
  std::vector<std::vector<int64_t>> samples(producers);
  for (auto &s : samples) s.resize(per_producer);

  auto t0 = Clock::now();
  std::thread consumer([&] {
    uint64_t got = 0, v;
    while (got < total) {
      if (q.dequeue(v)) got++;
      else std::this_thread::yield();
    }
  });
  std::vector<std::thread> threads;
  for (int p = 0; p < producers; p++)
    threads.emplace_back([&, p] {
      for (int i = 0; i < per_producer; i++) {
        auto s = Clock::now();
        q.enqueue(static_cast<uint64_t>(i));
        samples[p][i] = ns_since(s);
      }
    });
  for (auto &t : threads) t.join();
  consumer.join();
  double secs = ns_since(t0) / 1e9;

  std::vector<int64_t> all;
  for (auto &s : samples) all.insert(all.end(), s.begin(), s.end());
  return {total / secs / 1e6, percentile(all, 0.50), percentile(all, 0.99)};
}

static void run_queue_benchmark() {
  const int per_producer = 200000;
  std::cout << "## Queue: lock-free vs mutex\n\n";
  std::cout << "Items per producer: " << per_producer
            << ". One consumer thread. Latency is the time inside `enqueue()`.\n\n";
  std::cout << "| Queue | Producers | Throughput (M items/s) | enqueue P50 (ns) | enqueue P99 (ns) |\n";
  std::cout << "|---|---|---|---|---|\n";
  for (int producers : {1, 2, 4, 8}) {
    QueueResult lf = bench_queue<MPSCQueue<uint64_t>>(producers, per_producer);
    QueueResult mx = bench_queue<MutexQueue>(producers, per_producer);
    std::cout << "| lock-free | " << producers << " | " << fixed(lf.mops, 2) << " | " << lf.p50_ns
              << " | " << lf.p99_ns << " |\n";
    std::cout << "| mutex | " << producers << " | " << fixed(mx.mops, 2) << " | " << mx.p50_ns
              << " | " << mx.p99_ns << " |\n";
  }
  std::cout << "\n";
}

// ---- 2. order books ------------------------------------------------------------

struct Op {
  bool cancel;
  Order order;
  uint64_t cancel_id;
};

// Orders around a mid price that drifts a little, plus some cancels.
static std::vector<Op> make_ops(int n) {
  std::mt19937 rng(1);
  std::vector<Op> ops;
  ops.reserve(n);
  int64_t mid = 10000;
  for (int i = 1; i <= n; i++) {
    Op op{};
    if (i > 100 && rng() % 100 < 10) {
      op.cancel = true;
      op.cancel_id = i - 1 - rng() % 100; // a recent order
    } else {
      mid += static_cast<int64_t>(rng() % 3) - 1;
      mid = std::max<int64_t>(9500, std::min<int64_t>(10500, mid));
      op.order.order_id = op.order.seq = i;
      op.order.symbol_id = 1;
      op.order.side = rng() % 2 ? Side::Buy : Side::Sell;
      op.order.price = mid + static_cast<int64_t>(rng() % 21) - 10;
      op.order.qty = 1 + rng() % 100;
    }
    ops.push_back(op);
  }
  return ops;
}

struct BookResult {
  double mops;
  int64_t p50_ns, p99_ns;
  uint64_t trades;
};

template <class Book> BookResult bench_book(const std::vector<Op> &ops) {
  BookResult r{};
  std::vector<Trade> trades;
  {
    // Run 1: no per-call timing, for throughput.
    Book book;
    uint64_t next_trade = 1;
    auto t0 = Clock::now();
    for (const Op &op : ops) {
      trades.clear();
      if (op.cancel) book.cancel(op.cancel_id);
      else book.add(op.order, next_trade, trades);
    }
    r.mops = ops.size() / (ns_since(t0) / 1e9) / 1e6;
    r.trades = next_trade - 1;
  }
  {
    // Run 2: time every call, for P50 / P99.
    Book book;
    uint64_t next_trade = 1;
    std::vector<int64_t> samples;
    samples.reserve(ops.size());
    for (const Op &op : ops) {
      trades.clear();
      auto s = Clock::now();
      if (op.cancel) book.cancel(op.cancel_id);
      else book.add(op.order, next_trade, trades);
      samples.push_back(ns_since(s));
    }
    r.p50_ns = percentile(samples, 0.50);
    r.p99_ns = percentile(samples, 0.99);
  }
  return r;
}

static void run_book_benchmark() {
  const int n = 1000000;
  std::vector<Op> ops = make_ops(n);
  std::cout << "## Order book: std::map vs dense array\n\n";
  std::cout << n << " operations (about 10% cancels) on one symbol, prices within +-10 cents of a "
               "drifting mid price. One thread.\n\n";
  std::cout << "| Book | Throughput (M ops/s) | P50 (ns) | P99 (ns) | Trades |\n";
  std::cout << "|---|---|---|---|---|\n";
  BookResult m = bench_book<MapBook>(ops);
  BookResult d = bench_book<DenseBook>(ops);
  std::cout << "| MapBook (std::map) | " << fixed(m.mops, 2) << " | " << m.p50_ns << " | "
            << m.p99_ns << " | " << m.trades << " |\n";
  std::cout << "| DenseBook (array) | " << fixed(d.mops, 2) << " | " << d.p50_ns << " | "
            << d.p99_ns << " | " << d.trades << " |\n\n";
}

// ---- machine description -------------------------------------------------------

static std::string cpu_model() {
  std::ifstream f("/proc/cpuinfo");
  std::string line;
  while (std::getline(f, line))
    if (line.rfind("model name", 0) == 0) return line.substr(line.find(':') + 2);
  return "unknown";
}

#ifndef TF_BUILD_FLAGS
#define TF_BUILD_FLAGS "unknown"
#endif

int main() {
  std::cout << "# Benchmark run\n\n";
  std::cout << "- CPU: " << cpu_model() << "\n";
  std::cout << "- Logical cores: " << std::thread::hardware_concurrency() << "\n";
  std::cout << "- Compiler: " << __VERSION__ << "\n";
  std::cout << "- Flags: " << TF_BUILD_FLAGS << "\n";
  std::cout << "- Threads are not pinned to cores.\n\n";
  run_queue_benchmark();
  run_book_benchmark();
  return 0;
}
