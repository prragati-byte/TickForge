#pragma once
// Write path: appends one whole transaction to the log and (optionally)
// forces it to stable storage. POSIX only (open/write/fsync).
#include <cstdint>
#include <string>
#include <vector>

namespace wal {

class WalWriter {
public:
  // sync_on_commit=true  -> fsync after every commit (durable, slower)
  // sync_on_commit=false -> data reaches the OS only (survives process crash,
  //                         not power loss)
  WalWriter(std::string path, bool sync_on_commit);
  ~WalWriter();

  WalWriter(const WalWriter &) = delete;
  WalWriter &operator=(const WalWriter &) = delete;

  bool is_open() const { return fd_ >= 0; }

  // Writes BEGIN, all records, COMMIT as ONE write() call, then fsync.
  // Returns true only if the transaction is fully handed to the OS (and synced
  // when sync_on_commit is on).
  bool commit(uint64_t txid, const std::vector<std::string> &records);

private:
  std::string path_;
  bool sync_;
  int fd_;
};

} // namespace wal
