#pragma once
// In-memory state rebuilt from (and mirrored by) the WAL.
#include "wal/wal_record.hpp"
#include <algorithm>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <vector>

namespace wal {

struct DbState {
  std::unordered_map<std::string, std::string> kv;
  std::vector<Trade> trades;

  void apply(const Payload &p) {
    std::visit(
        [this](const auto &rec) {
          using T = std::decay_t<decltype(rec)>;
          if constexpr (std::is_same_v<T, SetRecord>) {
            kv[rec.key] = rec.value;
          } else {
            trades.push_back(rec);
          }
        },
        p);
  }

  // Next unused trade id (0 if no trades yet), so the engine can resume
  // numbering after a restart without reusing ids.
  uint64_t next_trade_id() const {
    uint64_t next = 0;
    for (const Trade &t : trades) {
      next = std::max(next, t.trade_id + 1);
    }
    return next;
  }

  void clear() {
    kv.clear();
    trades.clear();
  }
};

} // namespace wal
