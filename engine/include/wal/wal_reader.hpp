#pragma once
// Recovery scan: reads the log and returns only fully committed transactions.
#include <cstdint>
#include <string>
#include <vector>

namespace wal {

struct Transaction {
  uint64_t txid = 0;
  std::vector<std::string> records; // raw payload lines, in log order
};

struct ReadResult {
  bool file_found = false;
  std::vector<Transaction> committed;
  uint64_t max_txid = 0;        // largest txid seen in any BEGIN
  size_t discarded_txns = 0;    // started but never committed
  size_t skipped_lines = 0;     // malformed framing / stray lines
  bool torn_tail = false;       // last line had no '\n' (crash mid-write)
  uint64_t valid_bytes = 0;     // bytes covered by complete lines
};

// Rules:
//  - a transaction counts only if COMMIT|<same txid> follows its BEGIN
//  - a new BEGIN abandons an unfinished transaction
//  - a last line without '\n' is a torn write and is ignored
ReadResult read_committed(const std::string &path);

} // namespace wal
