#pragma once
// Elastic dual ring: a multi-producer, single-consumer queue that keeps FIFO order.
//
//   fast ring   a preallocated ring. Normal flow never allocates.
//   overflow    when the ring has no free slot, an item goes to a list on the
//               heap instead, so a burst never blocks a producer and never drops
//               an item. The ring is used again as soon as it has room.
//
// Order comes from one counter. Every enqueue takes the next ticket with
// fetch_add, and the consumer always takes tickets in order, whichever side
// each one went to. The two sides therefore never need a "switch mode" step,
// and an item in overflow can never be overtaken by a later one in the ring.
//
// Slot protocol (ring size C, slot index = ticket mod C). seq says what a slot is
// ready for:
//   seq == t       free, the producer holding ticket t may fill it
//   seq == t + 1   holds ticket t's item
// After the consumer has passed ticket t, by either route, it sets seq = t + C.
//
// A producer with ticket t that reads seq != t knows ticket t - C has not been
// passed yet, so the ring is full at that slot and it goes to overflow. Only the
// holder of ticket t can fill the slot, because seq becomes t only once and t + C
// cannot match until the consumer has passed t.
//
// Overflow is a Treiber stack. Producers push with compare-and-swap; the consumer
// takes the whole stack with exchange and files the nodes by ticket in a private
// map. Nodes are never popped singly and never reused while shared, so there is no
// ABA problem and no hazard pointers are needed.
//
// As with any ticket queue, a producer stopped between taking its ticket and
// publishing holds up the consumer until it runs again. Nothing is lost.

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <unordered_map>

template <typename T> class ElasticRing {
  struct Slot {
    std::atomic<uint64_t> seq;
    T data;
  };
  struct Node {
    uint64_t ticket;
    Node *next;
    T data;
  };

public:
  // Capacity is rounded up to a power of two.
  explicit ElasticRing(size_t capacity = 1 << 16) {
    size_t c = 2;
    while (c < capacity) c <<= 1;
    capacity_ = c;
    mask_ = c - 1;
    slots_.reset(new Slot[c]);
    for (size_t i = 0; i < c; i++) slots_[i].seq.store(i, std::memory_order_relaxed);
  }

  ElasticRing(const ElasticRing &) = delete;
  ElasticRing &operator=(const ElasticRing &) = delete;

  ~ElasticRing() {
    free_stack(overflow_.exchange(nullptr, std::memory_order_acquire));
    for (auto &entry : parked_) delete entry.second;
  }

  // Any thread. Never blocks on another producer and never fails.
  void enqueue(const T &value) {
    const uint64_t ticket = tail_.fetch_add(1, std::memory_order_acq_rel);
    Slot &slot = slots_[ticket & mask_];
    if (slot.seq.load(std::memory_order_acquire) == ticket) {
      slot.data = value;
      slot.seq.store(ticket + 1, std::memory_order_release);
      return;
    }
    // Slow path: the ring is full at this slot.
    Node *node = new Node{ticket, overflow_.load(std::memory_order_relaxed), value};
    while (!overflow_.compare_exchange_weak(node->next, node, std::memory_order_release,
                                            std::memory_order_relaxed)) {
    }
    overflowed_total_.fetch_add(1, std::memory_order_relaxed);
  }

  // Single consumer only. Returns false when the next item in order is not there yet.
  bool dequeue(T &out) {
    Slot &slot = slots_[head_ & mask_];
    if (slot.seq.load(std::memory_order_acquire) == head_ + 1) {
      out = slot.data;
    } else {
      if (!take_from_overflow(out)) return false;
    }
    slot.seq.store(head_ + capacity_, std::memory_order_release);
    head_++;
    head_public_.store(head_, std::memory_order_relaxed);
    return true;
  }

  // ---- depth monitoring; safe from any thread, approximate while items move ----

  size_t capacity() const { return capacity_; }
  uint64_t depth() const {
    uint64_t head = head_public_.load(std::memory_order_relaxed);
    uint64_t tail = tail_.load(std::memory_order_relaxed);
    return tail > head ? tail - head : 0;
  }
  // Items that have ever taken the slow path. Zero means the ring was always enough.
  uint64_t overflowed_total() const { return overflowed_total_.load(std::memory_order_relaxed); }

private:
  bool take_from_overflow(T &out) {
    if (overflow_.load(std::memory_order_relaxed) != nullptr) {
      Node *n = overflow_.exchange(nullptr, std::memory_order_acquire);
      while (n != nullptr) {
        Node *next = n->next;
        parked_[n->ticket] = n;
        n = next;
      }
    }
    if (parked_.empty()) return false;
    auto it = parked_.find(head_);
    if (it == parked_.end()) return false;
    out = it->second->data;
    delete it->second;
    parked_.erase(it);
    return true;
  }

  static void free_stack(Node *n) {
    while (n != nullptr) {
      Node *next = n->next;
      delete n;
      n = next;
    }
  }

  size_t capacity_ = 0;
  size_t mask_ = 0;
  std::unique_ptr<Slot[]> slots_;

  // Separate cache lines: producers write the first two, the consumer the rest.
  alignas(64) std::atomic<uint64_t> tail_{0};
  alignas(64) std::atomic<Node *> overflow_{nullptr};
  alignas(64) std::atomic<uint64_t> overflowed_total_{0};
  alignas(64) uint64_t head_ = 0;
  std::atomic<uint64_t> head_public_{0};
  std::unordered_map<uint64_t, Node *> parked_; // consumer only
};
