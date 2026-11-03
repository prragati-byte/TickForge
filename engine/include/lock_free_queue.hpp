#pragma once
// Multi-producer, single-consumer queue (Michael-Scott linked list).
//
// Producers call enqueue() from any thread. Only ONE thread may call dequeue().
// Hazard pointers keep a producer's tail pointer from being freed while it is
// still reading it.
//
// Changes made after the audit (see docs/DECISIONS.md, "Queue audit"):
//  1. dequeue() moves the tail forward before it frees the old head. Before,
//     a producer could read a lagging tail that the consumer had just freed
//     (a use after free; found by reading the code, the stress tests never
//     hit that timing window).
//  2. A hazard pointer is published with seq_cst, and the free-scan reads it
//     with seq_cst. With only release/acquire the store may be reordered after
//     the validation load.
//  3. Retired nodes live in a consumer-only std::vector. The old fixed array
//     of 1,024 slots could fill up and leak, and was scanned on every dequeue
//     (about 65,000 loads per item; the measured cost is in docs/DECISIONS.md).
//  4. Thread slots are handed out from a pool and given back when a thread
//     exits. The old counter wrapped at 64, so two threads could share one
//     hazard slot. Now at most MAX_THREADS threads may enqueue at the same
//     time; one more aborts with a message instead of corrupting memory.

#include <array>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace tf_queue_detail {

constexpr int MAX_THREADS = 128;

// Pool of hazard slot numbers shared by all queues in the process.
inline std::array<std::atomic<bool>, MAX_THREADS> &slot_pool() {
  static std::array<std::atomic<bool>, MAX_THREADS> pool{};
  return pool;
}

// One per thread; gives its slot back when the thread ends.
struct SlotOwner {
  int slot = -1;
  SlotOwner() {
    auto &pool = slot_pool();
    for (int i = 0; i < MAX_THREADS; i++) {
      bool expected = false;
      if (pool[i].compare_exchange_strong(expected, true)) {
        slot = i;
        return;
      }
    }
    std::fprintf(stderr, "MPSCQueue: more than %d producer threads\n", MAX_THREADS);
    std::abort();
  }
  ~SlotOwner() { slot_pool()[slot].store(false); }
};

inline int my_slot() {
  thread_local SlotOwner owner;
  return owner.slot;
}

} // namespace tf_queue_detail

template <typename T> class MPSCQueue {
  struct Node {
    std::atomic<Node *> next{nullptr};
    T data{};
  };

  static constexpr int MAX_THREADS = tf_queue_detail::MAX_THREADS;
  static constexpr size_t SCAN_EVERY = 64; // free retired nodes in batches

  std::atomic<Node *> head_;
  std::atomic<Node *> tail_;
  std::array<std::atomic<Node *>, MAX_THREADS> hazard_;
  std::vector<Node *> retired_; // touched by the consumer thread only

  // Free every retired node that no producer is pointing at.
  void reclaim() {
    std::array<Node *, MAX_THREADS> in_use;
    for (int i = 0; i < MAX_THREADS; i++)
      in_use[i] = hazard_[i].load(std::memory_order_seq_cst);

    size_t kept = 0;
    for (Node *n : retired_) {
      bool hazardous = false;
      for (Node *h : in_use)
        if (h == n) hazardous = true;
      if (hazardous) retired_[kept++] = n;
      else delete n;
    }
    retired_.resize(kept);
  }

public:
  MPSCQueue() {
    Node *dummy = new Node();
    head_.store(dummy, std::memory_order_relaxed);
    tail_.store(dummy, std::memory_order_relaxed);
    for (auto &h : hazard_) h.store(nullptr, std::memory_order_relaxed);
  }

  MPSCQueue(const MPSCQueue &) = delete;
  MPSCQueue &operator=(const MPSCQueue &) = delete;

  ~MPSCQueue() {
    for (Node *n : retired_) delete n;
    Node *cur = head_.load(std::memory_order_relaxed);
    while (cur != nullptr) {
      Node *next = cur->next.load(std::memory_order_relaxed);
      delete cur;
      cur = next;
    }
  }

  void enqueue(const T &value) {
    Node *node = new Node();
    node->data = value;
    std::atomic<Node *> &hazard = hazard_[tf_queue_detail::my_slot()];

    while (true) {
      Node *tail = tail_.load(std::memory_order_seq_cst);
      hazard.store(tail, std::memory_order_seq_cst);
      // The tail may have moved (and been freed) before the hazard was visible.
      if (tail != tail_.load(std::memory_order_seq_cst)) continue;

      Node *next = tail->next.load(std::memory_order_acquire);
      if (next != nullptr) {
        // Another producer linked its node but has not moved the tail yet.
        tail_.compare_exchange_weak(tail, next, std::memory_order_seq_cst);
        continue;
      }
      Node *expected = nullptr;
      if (tail->next.compare_exchange_weak(expected, node, std::memory_order_release,
                                           std::memory_order_relaxed)) {
        tail_.compare_exchange_strong(tail, node, std::memory_order_seq_cst);
        hazard.store(nullptr, std::memory_order_release);
        return;
      }
    }
  }

  // Single consumer only. Returns false when the queue is empty.
  bool dequeue(T &out) {
    Node *head = head_.load(std::memory_order_relaxed);
    Node *next = head->next.load(std::memory_order_acquire);
    if (next == nullptr) return false;
    out = next->data;

    // Never retire a node the tail still points to.
    Node *tail = head;
    tail_.compare_exchange_strong(tail, next, std::memory_order_seq_cst);

    head_.store(next, std::memory_order_relaxed);
    retired_.push_back(head);
    if (retired_.size() >= SCAN_EVERY) reclaim();
    return true;
  }
};
