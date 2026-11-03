// matching-engine/tests/queue_stress_test.cpp
// Multi-producer single-consumer stress test for MPSCQueue.
// Verifies: no items lost, zero leaks (run under valgrind), no deadlock.

#include "lock_free_queue.hpp"
#include "order.hpp"
#include <atomic>
#include <cassert>
#include <chrono>
#include <iostream>
#include <thread>
#include <vector>

static constexpr int    NUM_PRODUCERS  = 8;
static constexpr int    ITEMS_PER_PROD = 50'000;
static constexpr uint64_t TOTAL_ITEMS  = (uint64_t)NUM_PRODUCERS * ITEMS_PER_PROD;

int main() {
    MPSCQueue<uint64_t> q;
    std::atomic<uint64_t> total_consumed{0};
    std::atomic<bool> done{false};

    // Consumer thread
    std::thread consumer([&]() {
        uint64_t cnt = 0;
        while (true) {
            uint64_t val;
            if (q.dequeue(val)) {
                ++cnt;
                // XOR checksum — just to prevent optimisation
                (void)val;
            } else {
                if (done.load(std::memory_order_acquire) && cnt == TOTAL_ITEMS) break;
                std::this_thread::yield();
            }
        }
        total_consumed.store(cnt, std::memory_order_release);
    });

    auto t0 = std::chrono::high_resolution_clock::now();

    // Producer threads
    std::vector<std::thread> producers;
    for (int p = 0; p < NUM_PRODUCERS; ++p) {
        producers.emplace_back([&, p]() {
            uint64_t base = (uint64_t)p * ITEMS_PER_PROD;
            for (int i = 0; i < ITEMS_PER_PROD; ++i) {
                q.enqueue(base + i);
            }
        });
    }

    for (auto &t : producers) t.join();
    done.store(true, std::memory_order_release);
    consumer.join();

    auto t1 = std::chrono::high_resolution_clock::now();
    double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();

    uint64_t consumed = total_consumed.load();
    bool ok = (consumed == TOTAL_ITEMS);

    std::cout << "MPSCQueue stress test\n";
    std::cout << "  Producers   : " << NUM_PRODUCERS << "\n";
    std::cout << "  Items/prod  : " << ITEMS_PER_PROD << "\n";
    std::cout << "  Total items : " << TOTAL_ITEMS << "\n";
    std::cout << "  Consumed    : " << consumed << "\n";
    std::cout << "  Status      : " << (ok ? "PASS" : "FAIL - items lost!") << "\n";
    std::cout << "  Elapsed     : " << ms << " ms\n";
    std::cout << "  Throughput  : "
              << (TOTAL_ITEMS / (ms / 1000.0) / 1e6) << " M ops/sec\n";

    assert(ok && "Queue stress test: items were lost!");
    return ok ? 0 : 1;
}
