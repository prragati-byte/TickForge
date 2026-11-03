// Stress test for MPSCQueue. Also built with ThreadSanitizer and AddressSanitizer
// (see CMakeLists.txt).
//
// Every item is (producer number, counter). The consumer checks that
//   - nothing is lost or duplicated,
//   - items from one producer come out in the order they went in,
//   - the queue still works when far more than 128 threads have used it over
//     time (hazard slots are reused when a thread ends).
#include "lock_free_queue.hpp"
#include "test_util.hpp"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <thread>
#include <vector>

// Run `producers` threads that each push `per_producer` items. At most
// `at_once` threads run together; the rest start as earlier ones finish.
static void run_case(const char *name, int producers, int per_producer, int at_once) {
  MPSCQueue<uint64_t> q;
  const uint64_t total = static_cast<uint64_t>(producers) * per_producer;
  std::vector<uint64_t> next_expected(producers, 0);
  uint64_t consumed = 0;
  bool ok = true;

  auto t0 = std::chrono::steady_clock::now();

  std::thread consumer([&] {
    while (consumed < total) {
      uint64_t v;
      if (!q.dequeue(v)) {
        std::this_thread::yield();
        continue;
      }
      uint64_t p = v >> 32, i = v & 0xffffffffu;
      if (p >= static_cast<uint64_t>(producers) || next_expected[p] != i) ok = false;
      else next_expected[p]++;
      consumed++;
    }
  });

  for (int start = 0; start < producers; start += at_once) {
    std::vector<std::thread> batch;
    for (int p = start; p < producers && p < start + at_once; p++)
      batch.emplace_back([&q, p, per_producer] {
        for (int i = 0; i < per_producer; i++) q.enqueue((static_cast<uint64_t>(p) << 32) | i);
      });
    for (auto &t : batch) t.join();
  }
  consumer.join();

  uint64_t extra;
  CHECK(!q.dequeue(extra)); // nothing left over
  CHECK(ok);
  CHECK(consumed == total);

  double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  std::cout << "  " << name << ": " << producers << " producers x " << per_producer << " items, "
            << (ok && consumed == total ? "ok" : "FAILED") << ", " << ms << " ms\n";
}

int main() {
  run_case("8 producers at once", 8, 20000, 8);
  run_case("one producer, long run (more than 1024 retired nodes)", 1, 200000, 1);
  run_case("400 short-lived threads, 100 at a time", 400, 500, 100);
  return finish("queue_stress_test");
}
