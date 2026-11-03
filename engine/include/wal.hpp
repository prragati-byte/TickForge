#pragma once
// Write-ahead log: a binary file of length-prefixed, CRC-protected frames.
// File layout is described in docs/CONTRACTS.md, section 3.
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

class UringWriter;

// How the WAL reaches the kernel. Both give the same file and the same guarantee.
enum class WalIo { Write, Uring };

struct WalRecord {
  enum Type : uint8_t { NewOrder = 1, Cancel = 2 };
  Type type = NewOrder;
  uint64_t seq = 0;
  uint64_t ts_ms = 0;
  uint64_t order_id = 0; // for a cancel: the order to cancel
  uint32_t symbol_id = 0;
  uint8_t side = 0; // 0 = BUY, 1 = SELL
  int64_t price = 0;
  uint32_t qty = 0;
};

uint32_t crc32(const uint8_t *data, size_t len);

// Turn a record into a full frame (len, crc, payload) and back.
std::string wal_encode_frame(const WalRecord &r);

// The CRC field of the frame for this record. Identical records give identical frames.
uint32_t wal_frame_crc(const WalRecord &r);

// Decode the frame at the start of `data`. Incomplete: more bytes are needed.
// Corrupt: the bytes are there but wrong. On Ok, `frame_len` is the whole frame.
enum class WalFrame { Ok, Incomplete, Corrupt };
WalFrame wal_decode_frame(const void *data, size_t available, WalRecord &r, size_t &frame_len);

struct WalRecovery {
  uint64_t records = 0;       // good frames replayed
  uint64_t last_seq = 0;      // seq of the last good frame, 0 if none
  uint64_t dropped_bytes = 0; // bytes cut off the end (a half-written frame)
};

// Read the file, call `on_record` for every good frame in order, stop at the
// first cut-short or corrupt frame, then truncate the file after the last good
// frame. Creates the file (with its header) if it does not exist.
// Throws std::runtime_error on I/O errors or a file that is not a WAL.
WalRecovery wal_recover(const std::string &path,
                        const std::function<void(const WalRecord &)> &on_record);

// Appends frames to the end of the file. Not thread safe: callers lock.
class WalWriter {
public:
  // The file must exist (wal_recover first). WalIo::Uring throws if this kernel
  // cannot create a ring; see UringWriter::supported.
  explicit WalWriter(const std::string &path, WalIo io = WalIo::Write);
  ~WalWriter();
  WalWriter(const WalWriter &) = delete;
  WalWriter &operator=(const WalWriter &) = delete;

  // One write() call per frame, so a killed process leaves at most one
  // half-written frame. Throws std::runtime_error on failure.
  void append(const WalRecord &r);

private:
  int fd_;
  std::unique_ptr<UringWriter> uring_; // only with WalIo::Uring
};
