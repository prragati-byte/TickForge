#pragma once
// Facade tying the modules together: writer + reader + state.
// Single-writer: call from one thread (the matching thread's trade callback
// is exactly that).
#include "order.hpp"
#include "wal/db_state.hpp"
#include "wal/wal_writer.hpp"
#include <memory>
#include <string>

namespace wal {

struct RecoveryStats {
  bool file_found = false;
  size_t committed_txns = 0;
  size_t discarded_txns = 0;
  size_t skipped_lines = 0;     // framing problems
  size_t malformed_records = 0; // bad payload inside a committed tx
  bool torn_tail_repaired = false;
};

class WalDatabase {
public:
  explicit WalDatabase(std::string wal_path, bool sync_on_commit = true);

  // Each call is one atomic transaction: BEGIN, record, COMMIT.
  bool set_value(const std::string &key, const std::string &value);
  bool add_trade(const Trade &t);

  const DbState &state() const { return state_; }
  uint64_t next_trade_id() const { return state_.next_trade_id(); }
  const RecoveryStats &recovery_stats() const { return stats_; }

private:
  void recover();
  bool commit_one(const std::string &record);

  std::string path_;
  DbState state_;
  RecoveryStats stats_;
  uint64_t next_txid_ = 1;
  std::unique_ptr<WalWriter> writer_;
};

} // namespace wal
