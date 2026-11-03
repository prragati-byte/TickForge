#include "wal.hpp"
#include <array>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <stdexcept>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

static const char MAGIC[8] = {'T', 'F', 'W', 'A', 'L', '0', '0', '1'};
static const size_t MAX_PAYLOAD = 64; // the largest real payload is 42 bytes

uint32_t crc32(const uint8_t *data, size_t len) {
  // Built once; function-local statics are initialised thread-safely.
  static const std::array<uint32_t, 256> table = [] {
    std::array<uint32_t, 256> t{};
    for (uint32_t i = 0; i < 256; i++) {
      uint32_t c = i;
      for (int k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
      t[i] = c;
    }
    return t;
  }();
  uint32_t crc = 0xFFFFFFFFu;
  for (size_t i = 0; i < len; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >> 8);
  return crc ^ 0xFFFFFFFFu;
}

// ---- little-endian helpers ----------------------------------------------

static void put(std::string &s, uint64_t v, int bytes) {
  for (int i = 0; i < bytes; i++) s.push_back(static_cast<char>((v >> (8 * i)) & 0xff));
}

static uint64_t get(const uint8_t *p, int bytes) {
  uint64_t v = 0;
  for (int i = 0; i < bytes; i++) v |= static_cast<uint64_t>(p[i]) << (8 * i);
  return v;
}

std::string wal_encode_frame(const WalRecord &r) {
  std::string payload;
  put(payload, r.type, 1);
  put(payload, r.seq, 8);
  put(payload, r.ts_ms, 8);
  put(payload, r.order_id, 8);
  if (r.type == WalRecord::NewOrder) {
    put(payload, r.symbol_id, 4);
    put(payload, r.side, 1);
    put(payload, static_cast<uint64_t>(r.price), 8);
    put(payload, r.qty, 4);
  }
  std::string frame;
  put(frame, payload.size(), 4);
  put(frame, crc32(reinterpret_cast<const uint8_t *>(payload.data()), payload.size()), 4);
  return frame + payload;
}

// Returns false if the payload is not a valid record.
static bool decode_payload(const uint8_t *p, size_t len, WalRecord &r) {
  if (len < 25) return false;
  r.type = static_cast<WalRecord::Type>(p[0]);
  r.seq = get(p + 1, 8);
  r.ts_ms = get(p + 9, 8);
  r.order_id = get(p + 17, 8);
  if (r.type == WalRecord::Cancel) return len == 25;
  if (r.type != WalRecord::NewOrder || len != 42) return false;
  r.symbol_id = static_cast<uint32_t>(get(p + 25, 4));
  r.side = p[29];
  r.price = static_cast<int64_t>(get(p + 30, 8));
  r.qty = static_cast<uint32_t>(get(p + 38, 4));
  return r.side <= 1;
}

// ---- recovery -----------------------------------------------------------

static void write_all(int fd, const void *buf, size_t len) {
  const char *p = static_cast<const char *>(buf);
  while (len > 0) {
    ssize_t n = ::write(fd, p, len);
    if (n < 0) {
      if (errno == EINTR) continue;
      throw std::runtime_error(std::string("WAL write failed: ") + std::strerror(errno));
    }
    p += n;
    len -= static_cast<size_t>(n);
  }
}

WalRecovery wal_recover(const std::string &path,
                        const std::function<void(const WalRecord &)> &on_record) {
  int fd = ::open(path.c_str(), O_RDWR | O_CREAT, 0644);
  if (fd < 0) throw std::runtime_error("cannot open WAL " + path + ": " + std::strerror(errno));

  struct stat st;
  if (::fstat(fd, &st) != 0) {
    ::close(fd);
    throw std::runtime_error("cannot stat WAL " + path);
  }
  const uint64_t size = static_cast<uint64_t>(st.st_size);

  std::vector<uint8_t> data(size);
  size_t got = 0;
  while (got < size) {
    ssize_t n = ::pread(fd, data.data() + got, size - got, got);
    if (n <= 0) {
      ::close(fd);
      throw std::runtime_error("cannot read WAL " + path);
    }
    got += static_cast<size_t>(n);
  }

  WalRecovery result;
  uint64_t good_end = 0;

  if (size >= sizeof(MAGIC) && std::memcmp(data.data(), MAGIC, sizeof(MAGIC)) != 0) {
    ::close(fd);
    throw std::runtime_error(path + " is not a TickForge WAL (bad header)");
  }

  if (size < sizeof(MAGIC)) {
    // New file, or a header that was cut short: start again from the header.
    good_end = 0;
    if (::ftruncate(fd, 0) != 0) {
      ::close(fd);
      throw std::runtime_error("cannot truncate WAL");
    }
    write_all(fd, MAGIC, sizeof(MAGIC));
    result.dropped_bytes = size;
    good_end = sizeof(MAGIC);
  } else {
    good_end = sizeof(MAGIC);
    uint64_t pos = good_end;
    while (pos + 8 <= size) {
      uint64_t len = get(&data[pos], 4);
      uint32_t crc = static_cast<uint32_t>(get(&data[pos + 4], 4));
      if (len > MAX_PAYLOAD || pos + 8 + len > size) break; // cut short or garbage
      const uint8_t *payload = &data[pos + 8];
      if (crc32(payload, len) != crc) break;
      WalRecord rec;
      if (!decode_payload(payload, len, rec)) break;
      on_record(rec);
      result.records++;
      result.last_seq = rec.seq;
      pos += 8 + len;
      good_end = pos;
    }
    result.dropped_bytes = size - good_end;
    if (result.dropped_bytes > 0 && ::ftruncate(fd, static_cast<off_t>(good_end)) != 0) {
      ::close(fd);
      throw std::runtime_error("cannot truncate WAL");
    }
  }
  ::fsync(fd);
  ::close(fd);
  return result;
}

// ---- writer -------------------------------------------------------------

WalWriter::WalWriter(const std::string &path) {
  fd_ = ::open(path.c_str(), O_WRONLY | O_APPEND);
  if (fd_ < 0) throw std::runtime_error("cannot open WAL " + path + ": " + std::strerror(errno));
}

WalWriter::~WalWriter() { ::close(fd_); }

void WalWriter::append(const WalRecord &r) {
  std::string frame = wal_encode_frame(r);
  write_all(fd_, frame.data(), frame.size());
}
