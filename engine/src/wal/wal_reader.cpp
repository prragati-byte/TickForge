#include "wal/wal_reader.hpp"
#include "wal/wal_record.hpp"
#include <fstream>

namespace wal {

ReadResult read_committed(const std::string &path) {
  ReadResult res;
  std::ifstream file(path, std::ios::binary);
  if (!file.is_open()) {
    return res;
  }
  res.file_found = true;

  bool in_tx = false;
  uint64_t active = 0;
  std::vector<std::string> pending;
  uint64_t offset = 0;
  std::string line;

  auto abandon = [&]() {
    if (in_tx) {
      res.discarded_txns++;
    }
    in_tx = false;
    pending.clear();
  };

  while (std::getline(file, line)) {
    if (file.eof()) { // no trailing '\n' -> torn write
      res.torn_tail = true;
      break;
    }
    offset += line.size() + 1;
    res.valid_bytes = offset;

    size_t bar = line.find('|');
    std::string type = line.substr(0, bar);
    std::string rest = bar == std::string::npos ? "" : line.substr(bar + 1);

    if (type == "BEGIN") {
      abandon(); // previous tx never committed
      uint64_t id = 0;
      if (!parse_u64(rest, id)) {
        res.skipped_lines++;
        continue;
      }
      in_tx = true;
      active = id;
      if (id > res.max_txid) {
        res.max_txid = id;
      }
    } else if (type == "COMMIT") {
      uint64_t id = 0;
      if (in_tx && parse_u64(rest, id) && id == active) {
        res.committed.push_back({active, std::move(pending)});
        in_tx = false;
        pending.clear();
      } else {
        res.skipped_lines++;
        abandon();
      }
    } else if (in_tx) {
      pending.push_back(line);
    } else {
      res.skipped_lines++; // record outside any transaction
    }
  }

  abandon(); // unfinished transaction at EOF
  return res;
}

} // namespace wal
