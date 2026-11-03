#include "wal/wal_database.hpp"
#include "wal/wal_reader.hpp"
#include "wal/wal_record.hpp"
#include <filesystem>
#include <iostream>

namespace wal {

WalDatabase::WalDatabase(std::string wal_path, bool sync_on_commit)
    : path_(std::move(wal_path)) {
  recover();
  writer_ = std::make_unique<WalWriter>(path_, sync_on_commit);
}

void WalDatabase::recover() {
  state_.clear();
  stats_ = RecoveryStats{};

  ReadResult log = read_committed(path_);
  stats_.file_found = log.file_found;
  stats_.discarded_txns = log.discarded_txns;
  stats_.skipped_lines = log.skipped_lines;
  stats_.committed_txns = log.committed.size();

  for (const Transaction &tx : log.committed) {
    for (const std::string &line : tx.records) {
      if (auto rec = decode(line)) {
        state_.apply(*rec);
      } else {
        stats_.malformed_records++;
      }
    }
  }

  // Cut off a torn last line, otherwise the next BEGIN would be glued onto it.
  if (log.torn_tail) {
    std::error_code ec;
    std::filesystem::resize_file(path_, log.valid_bytes, ec);
    if (ec) {
      std::cerr << "WAL: could not truncate torn tail: " << ec.message()
                << "\n";
    } else {
      stats_.torn_tail_repaired = true;
    }
  }

  // Never reuse a txid, even one from an unfinished transaction.
  next_txid_ = log.max_txid + 1;
}

bool WalDatabase::commit_one(const std::string &record) {
  if (!writer_ || !writer_->is_open()) {
    return false;
  }
  return writer_->commit(next_txid_++, {record});
}

bool WalDatabase::set_value(const std::string &key, const std::string &value) {
  if (!valid_key(key) || !valid_value(value)) {
    std::cerr << "WAL: key/value contains forbidden characters\n";
    return false;
  }
  if (!commit_one(encode(SetRecord{key, value}))) {
    return false;
  }
  state_.kv[key] = value; // memory is updated only after the log is durable
  return true;
}

bool WalDatabase::add_trade(const Trade &t) {
  if (!commit_one(encode(t))) {
    return false;
  }
  state_.trades.push_back(t);
  return true;
}

} // namespace wal
