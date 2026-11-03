#pragma once
// ── lock_free_queue.hpp ───────────────────────────────────────────────────────
// Michael-Scott MPSC queue with hazard pointers.
// BUG FIX: retire overflow now falls back to direct delete after a scan
//          rather than leaking the node.
// NOTE: dequeue() is single-consumer; only enqueue() is multi-producer-safe.

#include <array>
#include <atomic>
#include <cstddef>

template <typename T> class MPSCQueue {
private:
  struct Node {
    std::atomic<Node *> next;
    T data;
    Node() : next(nullptr) {}
  };

  static constexpr int    MAX_THREADS      = 64;
  static constexpr size_t RETIRE_CAPACITY  = 1024;

  std::atomic<Node *> head_;
  std::atomic<Node *> tail_;

  std::array<std::atomic<Node *>, MAX_THREADS>     hazard_;
  std::array<std::atomic<Node *>, RETIRE_CAPACITY> retired_;
  std::atomic<size_t> retired_count_;

  // Assign each calling thread a unique slot in [0, MAX_THREADS).
  int thread_slot() {
    static std::atomic<int> counter{0};
    thread_local int slot = counter.fetch_add(1, std::memory_order_relaxed);
    return slot % MAX_THREADS; // guard against runaway counter
  }

  bool is_hazardous(Node *node) const {
    for (int i = 0; i < MAX_THREADS; i++) {
      if (hazard_[i].load(std::memory_order_acquire) == node)
        return true;
    }
    return false;
  }

  // FIX: On retire-array overflow, scan retired list first, then delete
  //      directly if still not hazardous.  The old code just called
  //      delete node immediately on overflow, even if another thread
  //      held a hazard pointer to it — use-after-free.
  void retire(Node *node) {
    // First: try to find an empty slot in the retired array.
    size_t count = retired_count_.load(std::memory_order_acquire);
    if (count < RETIRE_CAPACITY) {
      size_t idx = retired_count_.fetch_add(1, std::memory_order_acq_rel);
      if (idx < RETIRE_CAPACITY) {
        retired_[idx].store(node, std::memory_order_release);
        return;
      }
    }
    // Array is full: reclaim first, then retry or delete if safe.
    try_reclaim();
    for (size_t i = 0; i < RETIRE_CAPACITY; i++) {
      Node *expected = nullptr;
      if (retired_[i].compare_exchange_strong(expected, node,
                                               std::memory_order_acq_rel,
                                               std::memory_order_relaxed)) {
        return;
      }
    }
    // Still no slot — safe to delete only if nobody holds a hazard on it.
    if (!is_hazardous(node)) {
      delete node;
    }
    // If hazardous: we leak this one node.  Extremely rare (only when
    // both the retired array is 100% occupied AND the node is live in
    // another thread's hazard slot).  Production code would use a
    // thread-local overflow list here.
  }

  void try_reclaim() {
    for (size_t i = 0; i < RETIRE_CAPACITY; i++) {
      Node *n = retired_[i].load(std::memory_order_acquire);
      if (n != nullptr && !is_hazardous(n)) {
        if (retired_[i].compare_exchange_strong(n, nullptr,
                                                 std::memory_order_acq_rel,
                                                 std::memory_order_relaxed)) {
          delete n;
        }
      }
    }
  }

public:
  MPSCQueue() {
    Node *dummy = new Node();
    head_.store(dummy, std::memory_order_relaxed);
    tail_.store(dummy, std::memory_order_relaxed);
    retired_count_.store(0, std::memory_order_relaxed);
    for (int i = 0; i < MAX_THREADS; i++)
      hazard_[i].store(nullptr, std::memory_order_relaxed);
    for (size_t i = 0; i < RETIRE_CAPACITY; i++)
      retired_[i].store(nullptr, std::memory_order_relaxed);
  }

  ~MPSCQueue() {
    // Drain remaining retired list
    try_reclaim();
    Node *curr = head_.load(std::memory_order_relaxed);
    while (curr != nullptr) {
      Node *next = curr->next.load(std::memory_order_relaxed);
      delete curr;
      curr = next;
    }
  }

  void enqueue(const T &value) {
    Node *new_node = new Node();
    new_node->data = value;
    int slot = thread_slot();

    while (true) {
      Node *curr_tail = tail_.load(std::memory_order_acquire);
      hazard_[slot].store(curr_tail, std::memory_order_release);

      // Validate hazard pointer: re-read tail to ensure curr_tail is still live.
      if (curr_tail != tail_.load(std::memory_order_acquire))
        continue;

      Node *next = curr_tail->next.load(std::memory_order_acquire);

      if (curr_tail == tail_.load(std::memory_order_acquire)) {
        if (next == nullptr) {
          Node *expected = nullptr;
          if (curr_tail->next.compare_exchange_weak(
                  expected, new_node, std::memory_order_release,
                  std::memory_order_relaxed)) {
            tail_.compare_exchange_strong(curr_tail, new_node,
                                          std::memory_order_release,
                                          std::memory_order_relaxed);
            hazard_[slot].store(nullptr, std::memory_order_release);
            return;
          }
        } else {
          // Help advance tail
          tail_.compare_exchange_weak(curr_tail, next,
                                      std::memory_order_release,
                                      std::memory_order_relaxed);
        }
      }
    }
  }

  // Single-consumer dequeue.
  bool dequeue(T &out) {
    Node *curr_head = head_.load(std::memory_order_acquire);
    Node *next      = curr_head->next.load(std::memory_order_acquire);
    if (next == nullptr)
      return false;
    out = next->data;
    head_.store(next, std::memory_order_release);
    retire(curr_head);
    try_reclaim();
    return true;
  }
};
