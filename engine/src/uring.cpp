#include "uring.hpp"

#include <cerrno>
#include <cstring>
#include <stdexcept>

#if defined(__linux__) && __has_include(<linux/io_uring.h>)
#define TF_HAVE_URING 1
#include <linux/io_uring.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>
#else
#define TF_HAVE_URING 0
#endif

#if TF_HAVE_URING

static int ring_setup(unsigned entries, io_uring_params *p) {
  return static_cast<int>(syscall(__NR_io_uring_setup, entries, p));
}

static int ring_enter(int fd, unsigned to_submit, unsigned min_complete, unsigned flags) {
  return static_cast<int>(syscall(__NR_io_uring_enter, fd, to_submit, min_complete, flags, nullptr, 0));
}

struct UringWriter::Ring {
  int fd = -1;
  void *sq_map = MAP_FAILED, *cq_map = MAP_FAILED;
  size_t sq_size = 0, cq_size = 0;
  io_uring_sqe *sqes = static_cast<io_uring_sqe *>(MAP_FAILED);
  size_t sqes_size = 0;
  unsigned *sq_head = nullptr, *sq_tail = nullptr, *sq_mask = nullptr, *sq_array = nullptr;
  unsigned *cq_head = nullptr, *cq_tail = nullptr, *cq_mask = nullptr;
  io_uring_cqe *cqes = nullptr;

  ~Ring() {
    if (sqes != MAP_FAILED) munmap(sqes, sqes_size);
    if (cq_map != MAP_FAILED && cq_map != sq_map) munmap(cq_map, cq_size);
    if (sq_map != MAP_FAILED) munmap(sq_map, sq_size);
    if (fd >= 0) close(fd);
  }

  static char *at(void *base, unsigned offset) { return static_cast<char *>(base) + offset; }

  void open_ring() {
    io_uring_params p;
    std::memset(&p, 0, sizeof(p));
    fd = ring_setup(4, &p);
    if (fd < 0) throw std::runtime_error(std::string("io_uring_setup: ") + std::strerror(errno));

    sq_size = p.sq_off.array + p.sq_entries * sizeof(unsigned);
    cq_size = p.cq_off.cqes + p.cq_entries * sizeof(io_uring_cqe);
    const bool one_map = p.features & IORING_FEAT_SINGLE_MMAP;
    if (one_map) sq_size = cq_size = sq_size > cq_size ? sq_size : cq_size;

    sq_map = mmap(nullptr, sq_size, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_POPULATE, fd, IORING_OFF_SQ_RING);
    if (sq_map == MAP_FAILED) throw std::runtime_error("io_uring: cannot map the submission ring");
    cq_map = one_map ? sq_map
                     : mmap(nullptr, cq_size, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_POPULATE, fd,
                            IORING_OFF_CQ_RING);
    if (cq_map == MAP_FAILED) throw std::runtime_error("io_uring: cannot map the completion ring");
    sqes_size = p.sq_entries * sizeof(io_uring_sqe);
    sqes = static_cast<io_uring_sqe *>(
        mmap(nullptr, sqes_size, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_POPULATE, fd, IORING_OFF_SQES));
    if (sqes == MAP_FAILED) throw std::runtime_error("io_uring: cannot map the submission entries");

    sq_head = reinterpret_cast<unsigned *>(at(sq_map, p.sq_off.head));
    sq_tail = reinterpret_cast<unsigned *>(at(sq_map, p.sq_off.tail));
    sq_mask = reinterpret_cast<unsigned *>(at(sq_map, p.sq_off.ring_mask));
    sq_array = reinterpret_cast<unsigned *>(at(sq_map, p.sq_off.array));
    cq_head = reinterpret_cast<unsigned *>(at(cq_map, p.cq_off.head));
    cq_tail = reinterpret_cast<unsigned *>(at(cq_map, p.cq_off.tail));
    cq_mask = reinterpret_cast<unsigned *>(at(cq_map, p.cq_off.ring_mask));
    cqes = reinterpret_cast<io_uring_cqe *>(at(cq_map, p.cq_off.cqes));
  }

  // One write, one completion. Returns what write() would: bytes written, or -errno.
  int write_once(int file, const void *data, unsigned len) {
    const unsigned tail = __atomic_load_n(sq_tail, __ATOMIC_RELAXED);
    const unsigned index = tail & *sq_mask;
    io_uring_sqe &sqe = sqes[index];
    std::memset(&sqe, 0, sizeof(sqe));
    sqe.opcode = IORING_OP_WRITE;
    sqe.fd = file;
    sqe.addr = reinterpret_cast<unsigned long long>(data);
    sqe.len = len;
    sqe.off = static_cast<unsigned long long>(-1); // the file's position; the end for O_APPEND
    sq_array[index] = index;
    __atomic_store_n(sq_tail, tail + 1, __ATOMIC_RELEASE);

    for (;;) {
      unsigned pending = tail + 1 - __atomic_load_n(sq_head, __ATOMIC_ACQUIRE);
      int r = ring_enter(fd, pending, 1, IORING_ENTER_GETEVENTS);
      if (r < 0 && errno != EINTR && errno != EAGAIN && errno != EBUSY)
        throw std::runtime_error(std::string("io_uring_enter: ") + std::strerror(errno));
      unsigned head = __atomic_load_n(cq_head, __ATOMIC_RELAXED);
      if (head != __atomic_load_n(cq_tail, __ATOMIC_ACQUIRE)) {
        int res = cqes[head & *cq_mask].res;
        __atomic_store_n(cq_head, head + 1, __ATOMIC_RELEASE);
        return res;
      }
    }
  }
};

bool UringWriter::supported(std::string *why) {
  io_uring_params p;
  std::memset(&p, 0, sizeof(p));
  int fd = ring_setup(4, &p);
  if (fd < 0) {
    if (why) *why = std::string("io_uring_setup failed: ") + std::strerror(errno);
    return false;
  }
  close(fd);
  return true;
}

UringWriter::UringWriter() {
  Ring *ring = new Ring();
  try {
    ring->open_ring();
  } catch (...) {
    delete ring;
    throw;
  }
  ring_ = ring;
}

UringWriter::~UringWriter() { delete ring_; }

void UringWriter::write_all(int fd, const void *data, size_t len) {
  const char *p = static_cast<const char *>(data);
  while (len > 0) {
    int r = ring_->write_once(fd, p, static_cast<unsigned>(len));
    if (r == -EINTR || r == -EAGAIN) continue;
    if (r < 0) throw std::runtime_error(std::string("WAL write failed: ") + std::strerror(-r));
    p += r;
    len -= static_cast<size_t>(r);
  }
}

#else // no io_uring on this platform

struct UringWriter::Ring {};

bool UringWriter::supported(std::string *why) {
  if (why) *why = "io_uring only exists on Linux";
  return false;
}

UringWriter::UringWriter() { throw std::runtime_error("io_uring only exists on Linux"); }
UringWriter::~UringWriter() {}
void UringWriter::write_all(int, const void *, size_t) {}

#endif
