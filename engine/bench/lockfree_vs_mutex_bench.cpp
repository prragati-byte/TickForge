// matching-engine/benchmarks/lockfree_vs_mutex_bench.cpp
// Throughput benchmark: MPSCQueue vs std::mutex + std::queue
// Tests 1, 2, 4, 8 producers × fixed item count, single consumer.

#include "lock_free_queue.hpp"
#include "order.hpp"

#include <atomic>
#include <chrono>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <vector>

static constexpr int ITEMS_PER_PROD = 100'000;

// ── Mutex-backed queue ────────────────────────────────────────────────────────
struct MutexQueue {
    std::mutex mu;
    std::queue<uint64_t> q;

    void enqueue(uint64_t v) {
        std::lock_guard<std::mutex> lk(mu);
        q.push(v);
    }
    bool dequeue(uint64_t &out) {
        std::lock_guard<std::mutex> lk(mu);
        if (q.empty()) return false;
        out = q.front();
        q.pop();
        return true;
    }
};

// ── Generic benchmark runner ──────────────────────────────────────────────────
template <typename Q>
double run_bench(Q &queue, int num_producers) {
    const uint64_t total = (uint64_t)num_producers * ITEMS_PER_PROD;
    std::atomic<bool> done{false};
    std::atomic<uint64_t> consumed{0};

    std::thread consumer([&]() {
        uint64_t cnt = 0;
        while (true) {
            uint64_t v;
            if (queue.dequeue(v)) {
                ++cnt;
            } else {
                if (done.load(std::memory_order_acquire) && cnt == total) break;
                std::this_thread::yield();
            }
        }
        consumed.store(cnt);
    });

    auto t0 = std::chrono::high_resolution_clock::now();

    std::vector<std::thread> producers;
    for (int p = 0; p < num_producers; ++p) {
        producers.emplace_back([&, p]() {
            uint64_t base = (uint64_t)p * ITEMS_PER_PROD;
            for (int i = 0; i < ITEMS_PER_PROD; ++i)
                queue.enqueue(base + i);
        });
    }
    for (auto &t : producers) t.join();
    done.store(true, std::memory_order_release);
    consumer.join();

    auto t1 = std::chrono::high_resolution_clock::now();
    double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();

    if (consumed.load() != total) {
        std::cerr << "[bench] WARNING: lost items! consumed=" << consumed.load()
                  << " expected=" << total << "\n";
    }
    return ms;
}

int main() {
    std::cout << "\n=== TickForge Queue Benchmark ===\n";
    std::cout << "Items per producer: " << ITEMS_PER_PROD << "\n\n";

    std::cout << std::left
              << std::setw(12) << "Queue"
              << std::setw(12) << "Producers"
              << std::setw(14) << "Total items"
              << std::setw(12) << "Time (ms)"
              << std::setw(18) << "Throughput(M/s)"
              << "\n";
    std::cout << std::string(68, '-') << "\n";

    for (int np : {1, 2, 4, 8}) {
        // Lock-free MPSCQueue
        {
            MPSCQueue<uint64_t> lf;
            double ms = run_bench(lf, np);
            uint64_t total = (uint64_t)np * ITEMS_PER_PROD;
            double mops = total / (ms / 1000.0) / 1e6;
            std::cout << std::left
                      << std::setw(12) << "LockFree"
                      << std::setw(12) << np
                      << std::setw(14) << total
                      << std::setw(12) << std::fixed << std::setprecision(1) << ms
                      << std::setw(18) << std::setprecision(2) << mops
                      << "\n";
        }
        // Mutex queue
        {
            MutexQueue mq;
            double ms = run_bench(mq, np);
            uint64_t total = (uint64_t)np * ITEMS_PER_PROD;
            double mops = total / (ms / 1000.0) / 1e6;
            std::cout << std::left
                      << std::setw(12) << "MutexQueue"
                      << std::setw(12) << np
                      << std::setw(14) << total
                      << std::setw(12) << std::fixed << std::setprecision(1) << ms
                      << std::setw(18) << std::setprecision(2) << mops
                      << "\n";
        }
        std::cout << "\n";
    }
    return 0;
}
