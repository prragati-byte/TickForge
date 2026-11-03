#include "wal/wal_writer.hpp"
#include "wal/wal_record.hpp"
#include "wal/wal_reader.hpp"
#include "wal/db_state.hpp"
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <iostream>
#include <unistd.h>
#include <cstdint>

namespace wal {

WalWriter::WalWriter(std::string path, bool sync_on_commit)
    : path_(std::move(path)), sync_(sync_on_commit),
      fd_(::open(path_.c_str(), O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC,
                 0644)) {
  if (fd_ < 0) {
    std::cerr << "WAL: cannot open " << path_ << ": " << std::strerror(errno)
              << "\n";
  }
}

WalWriter::~WalWriter() {
  if (fd_ >= 0) {
    ::close(fd_);
  }
}

bool WalWriter::commit(uint64_t txid, const std::vector<std::string> &records) {
  if (fd_ < 0) {
    return false;
  }

  std::string buf = begin_line(txid) + '\n';
  for (const std::string &r : records) {
    buf += r;
    buf += '\n';
  }
  buf += commit_line(txid);
  buf += '\n';

  const char *p = buf.data();
  size_t left = buf.size();
  while (left > 0) {
    ssize_t n = ::write(fd_, p, left);
    if (n < 0) {
      if (errno == EINTR) {
        continue;
      }
      std::cerr << "WAL: write failed: " << std::strerror(errno) << "\n";
      return false;
    }
    p += n;
    left -= static_cast<size_t>(n);
  }

  if (sync_ && ::fsync(fd_) != 0) {
    std::cerr << "WAL: fsync failed: " << std::strerror(errno) << "\n";
    return false;
  }
  return true;
}
// ── Global WAL instance (used by Rust FFI) ───────────────────────────────

static wal::WalWriter* global_wal_writer = nullptr;
static std::string     global_wal_path;

extern "C" {
    // 1. Initialize the WAL writer
    bool c_wal_init(const char* path, bool sync_on_commit) {
        global_wal_path = std::string(path);
        if (global_wal_writer != nullptr) {
            delete global_wal_writer;
        }
        global_wal_writer = new wal::WalWriter(global_wal_path, sync_on_commit);
        return true;
    }

    // 2. Append a single trade record as one WAL transaction
    bool c_wal_commit_records(uint64_t txid, const char** records_array, size_t array_len) {
        if (global_wal_writer == nullptr) return false;
        std::vector<std::string> cpp_records;
        cpp_records.reserve(array_len);
        for (size_t i = 0; i < array_len; ++i)
            cpp_records.push_back(std::string(records_array[i]));
        return global_wal_writer->commit(txid, cpp_records);
    }

    // 3. Replay: scan committed transactions and invoke callback for each TRADE line.
    //    callback(line_ptr, line_len) is called once per payload line inside a committed tx.
    //    Returns the number of committed transactions replayed.
    uint64_t c_wal_replay_records(const char* path,
                                   void (*callback)(const char* line, size_t len)) {
        wal::ReadResult res = wal::read_committed(std::string(path));
        for (const wal::Transaction& tx : res.committed) {
            for (const std::string& line : tx.records) {
                if (callback) {
                    callback(line.c_str(), line.size());
                }
            }
        }
        return static_cast<uint64_t>(res.committed.size());
    }

    // 4. Close the file descriptor when shutting down
    void c_wal_close() {
        if (global_wal_writer != nullptr) {
            delete global_wal_writer;
            global_wal_writer = nullptr;
        }
    }
}

} // namespace wal
