// Benchmarks. Output is markdown, so it can be pasted into docs:
//   ./engine_bench [directory for WAL files] > last_run.md
//
// 1. Queue: MPSCQueue (lock-free) vs std::mutex + std::deque, many producers
//    and one consumer. Reports throughput (items handed over per second) and
//    how long the producer spends inside enqueue() (P50 / P99).
//    Then a burst: the consumer starts late, so the queue has to hold everything.
// 2. Book: MapBook (std::map) vs DenseBook (array of cache-line levels), same
//    stream of orders. Reports throughput and time per add() call (P50 / P99).
//
// Per-call times are taken with steady_clock around each call. That clock read
// costs roughly 20-30 ns itself, so small numbers include that overhead.
#include "dense_book.hpp"
#include "elastic_ring.hpp"
#include "lock_free_queue.hpp"
#include "map_book.hpp"
#include "uring.hpp"
#include "wal.hpp"

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

// Four producers push `per_producer` items each while the consumer is held back
// for `delay_ms`, then it drains. Shows what each queue does when a burst arrives.
struct BurstResult {
  int64_t enqueue_p50_ns, enqueue_p99_ns;
  double drain_ms;
};

template <class Q> BurstResult bench_burst(int per_producer, int delay_ms, Q &q) {
  const int producers = 4;
  const uint64_t total = static_cast<uint64_t>(producers) * per_producer;
  std::vector<std::vector<int64_t>> samples(producers);
  for (auto &s : samples) s.resize(per_producer);
  double drain_ms = 0;
  std::thread consumer([&] {
    std::this_thread::sleep_for(std::chrono::milliseconds(delay_ms));
    auto t0 = Clock::now();
    uint64_t got = 0, v;
    while (got < total) {
      if (q.dequeue(v)) got++;
      else std::this_thread::yield();
    }
    drain_ms = ns_since(t0) / 1e6;
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
  std::vector<int64_t> all;
  for (auto &s : samples) all.insert(all.end(), s.begin(), s.end());
  return {percentile(all, 0.50), percentile(all, 0.99), drain_ms};
}

static void run_burst_benchmark() {
  const int per_producer = 250000;
  std::cout << "## Queue burst: consumer starts 20 ms late\n\n";
  std::cout << "4 producers, " << per_producer << " items each. Elastic rings are sized so the burst "
            << "fits (2^21 slots), half fits (2^18), or barely fits at all (2^8).\n\n";
  std::cout << "| Queue | enqueue P50 (ns) | enqueue P99 (ns) | Drain (ms) | Items through overflow |\n";
  std::cout << "|---|---|---|---|---|\n";
  auto print = [](const std::string &name, const BurstResult &r, const std::string &overflow) {
    std::cout << "| " << name << " | " << r.enqueue_p50_ns << " | " << r.enqueue_p99_ns << " | "
              << fixed(r.drain_ms, 1) << " | " << overflow << " |\n";
  };
  {
    MPSCQueue<uint64_t> q;
    print("lock-free list", bench_burst(per_producer, 20, q), "every item is a heap node");
  }
  for (int bits : {21, 18, 8}) {
    ElasticRing<uint64_t> q(size_t{1} << bits);
    BurstResult r = bench_burst(per_producer, 20, q);
    print("elastic ring 2^" + std::to_string(bits), r, std::to_string(q.overflowed_total()));
  }
  std::cout << "\n";
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
    QueueResult el = bench_queue<ElasticRing<uint64_t>>(producers, per_producer);
    std::cout << "| lock-free | " << producers << " | " << fixed(lf.mops, 2) << " | " << lf.p50_ns
              << " | " << lf.p99_ns << " |\n";
    std::cout << "| mutex | " << producers << " | " << fixed(mx.mops, 2) << " | " << mx.p50_ns
              << " | " << mx.p99_ns << " |\n";
    std::cout << "| elastic ring | " << producers << " | " << fixed(el.mops, 2) << " | " << el.p50_ns
              << " | " << el.p99_ns << " |\n";
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

// ---- 3. WAL write ---------------------------------------------------------------

static void bench_wal_once(const std::string &path, WalIo io, int frames, std::vector<int64_t> &samples) {
  std::remove(path.c_str());
  wal_recover(path, [](const WalRecord &) {});
  WalWriter w(path, io);
  for (int i = 1; i <= frames; i++) {
    WalRecord r;
    r.seq = r.order_id = r.ts_ms = i;
    r.symbol_id = 1;
    r.price = 10000 + i % 100;
    r.qty = 1 + i % 50;
    auto s = Clock::now();
    w.append(r);
    samples.push_back(ns_since(s));
  }
  std::remove(path.c_str());
}

static void run_wal_benchmark(const std::string &dir) {
  const int frames = 200000, runs = 5;
  std::string why;
  std::cout << "## WAL append: write() vs io_uring\n\n";
  if (!UringWriter::supported(&why)) {
    std::cout << "Not run: " << why << "\n\n";
    return;
  }
  std::cout << frames << " frames per run, " << runs << " runs each, taking turns, one thread, no fsync. "
            << "One frame per system call and the call waits for the result, because the engine must "
            << "not acknowledge an order before its frame is written. Per-call time includes about "
            << "20-30 ns for reading the clock.\n\n";
  std::cout << "| Backend | P50 (ns) | P99 (ns) | P99.9 (ns) | Frames/s |\n|---|---|---|---|---|\n";
  std::vector<int64_t> plain, uring;
  double plain_s = 0, uring_s = 0;
  const std::string path = dir + "/engine_bench.wal";
  for (int r = 0; r < runs; r++) {
    auto t0 = Clock::now();
    bench_wal_once(path, WalIo::Write, frames, plain);
    plain_s += ns_since(t0) / 1e9;
    t0 = Clock::now();
    bench_wal_once(path, WalIo::Uring, frames, uring);
    uring_s += ns_since(t0) / 1e9;
  }
  const double total = static_cast<double>(frames) * runs;
  auto row = [&](const char *name, std::vector<int64_t> &v, double secs) {
    std::cout << "| " << name << " | " << percentile(v, 0.50) << " | " << percentile(v, 0.99) << " | "
              << percentile(v, 0.999) << " | " << fixed(total / secs, 0) << " |\n";
  };
  row("write()", plain, plain_s);
  row("io_uring", uring, uring_s);
  std::cout << "\n";
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

int main(int argc, char **argv) {
  const std::string wal_dir = argc > 1 ? argv[1] : ".";
  std::cout << "# Benchmark run\n\n";
  std::cout << "- CPU: " << cpu_model() << "\n";
  std::cout << "- Logical cores: " << std::thread::hardware_concurrency() << "\n";
  std::cout << "- Compiler: " << __VERSION__ << "\n";
  std::cout << "- Flags: " << TF_BUILD_FLAGS << "\n";
  std::cout << "- Threads are not pinned to cores.\n\n";
  run_queue_benchmark();
  run_burst_benchmark();
  run_book_benchmark();
  run_wal_benchmark(wal_dir);
  return 0;
}
