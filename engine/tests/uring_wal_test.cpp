// The WAL written through io_uring must behave exactly like the one written with
// write(): same bytes, same recovery, and every frame acknowledged before a
// kill -9 is still there afterwards.
//
// Exits with 77 (reported by ctest as skipped) if this kernel cannot create a ring.
#include "exchange.hpp"
#include "map_book.hpp"
#include "replay.hpp"
#include "test_util.hpp"
#include "uring.hpp"
#include "wal.hpp"

#include <csignal>
#include <cstdlib>
#include <fcntl.h>
#include <fstream>
#include <random>
#include <sstream>
#include <string>
#include <sys/wait.h>
#include <unistd.h>
#include <vector>

static std::string read_file(const std::string &path) {
  std::ifstream f(path, std::ios::binary);
  std::stringstream s;
  s << f.rdbuf();
  return s.str();
}

static std::vector<WalRecord> make_records(int n) {
  std::mt19937 rng(5);
  std::vector<WalRecord> recs;
  for (int i = 1; i <= n; i++) {
    WalRecord r;
    r.seq = i;
    r.ts_ms = 1000 + i;
    r.order_id = i;
    if (i > 10 && rng() % 10 == 0) {
      r.type = WalRecord::Cancel;
      r.order_id = 1 + rng() % (i - 1);
    } else {
      r.symbol_id = 1 + rng() % 3;
      r.side = rng() % 2;
      r.price = 9900 + rng() % 200;
      r.qty = 1 + rng() % 100;
    }
    recs.push_back(r);
  }
  return recs;
}

static void write_records(const std::string &path, const std::vector<WalRecord> &recs, WalIo io) {
  std::remove(path.c_str());
  wal_recover(path, [](const WalRecord &) {});
  WalWriter w(path, io);
  for (const WalRecord &r : recs) w.append(r);
}

static void test_same_bytes_and_state(const std::string &dir) {
  std::vector<WalRecord> recs = make_records(20000);
  std::string a = dir + "/write.wal", b = dir + "/uring.wal";
  write_records(a, recs, WalIo::Write);
  write_records(b, recs, WalIo::Uring);
  CHECK(read_file(a).size() > 0);
  CHECK(read_file(a) == read_file(b));

  Exchange<MapBook> ea, eb;
  WalRecovery ra = recover_exchange(a, ea), rb = recover_exchange(b, eb);
  CHECK(ra.records == recs.size());
  CHECK(rb.records == recs.size());
  CHECK(rb.dropped_bytes == 0);
  CHECK(ea.state_hash() == eb.state_hash());
}

// A restart can change the setting: frames from both writers end up in one valid file.
static void test_switching_backend_on_one_file(const std::string &dir) {
  std::vector<WalRecord> recs = make_records(300);
  std::string mixed = dir + "/mixed.wal", plain = dir + "/plain.wal";
  std::remove(mixed.c_str());
  wal_recover(mixed, [](const WalRecord &) {});
  for (size_t i = 0; i < recs.size(); i += 100) {
    WalWriter w(mixed, i % 200 == 0 ? WalIo::Uring : WalIo::Write);
    for (size_t k = i; k < i + 100; k++) w.append(recs[k]);
  }
  write_records(plain, recs, WalIo::Write);
  CHECK(read_file(mixed) == read_file(plain));
}

// A write that cannot succeed must be reported, not lost.
static void test_errors_are_reported(const std::string &dir) {
  std::string path = dir + "/readonly";
  int fd = ::open(path.c_str(), O_CREAT | O_RDONLY, 0644);
  CHECK(fd >= 0);
  UringWriter u;
  bool threw = false;
  try {
    u.write_all(fd, "x", 1);
  } catch (const std::exception &) {
    threw = true;
  }
  CHECK(threw);
  ::close(fd);
}

// The child reports each frame after append() returned. Everything it reported
// must be in the file after kill -9, and the file must be a clean sequence.
static void test_kill_writer(const std::string &dir) {
  std::string path = dir + "/kill.wal";
  std::remove(path.c_str());
  wal_recover(path, [](const WalRecord &) {});
  int pipefd[2];
  CHECK(::pipe(pipefd) == 0);

  pid_t pid = fork();
  if (pid == 0) {
    ::close(pipefd[0]);
    WalWriter w(path, WalIo::Uring);
    for (uint64_t seq = 1;; seq++) {
      WalRecord r;
      r.seq = seq;
      r.ts_ms = seq;
      r.order_id = seq;
      r.symbol_id = 1;
      r.side = seq % 2;
      r.price = 10000 + seq % 7;
      r.qty = 1 + seq % 50;
      w.append(r);
      if (::write(pipefd[1], &seq, sizeof(seq)) != sizeof(seq)) _exit(1);
    }
  }
  ::close(pipefd[1]);

  uint64_t last_acked = 0, v;
  for (int i = 0; i < 2000; i++) {
    if (::read(pipefd[0], &v, sizeof(v)) == sizeof(v)) last_acked = v;
  }
  kill(pid, SIGKILL);
  while (::read(pipefd[0], &v, sizeof(v)) == sizeof(v)) last_acked = v;
  ::close(pipefd[0]);
  waitpid(pid, nullptr, 0);

  uint64_t expect = 1;
  bool in_order = true;
  WalRecovery r = wal_recover(path, [&](const WalRecord &rec) { in_order = in_order && rec.seq == expect++; });
  CHECK(in_order);
  CHECK(last_acked >= 2000);
  CHECK(r.last_seq >= last_acked);
  std::printf("  killed writer: %llu reported, %llu in the file, %llu dropped bytes\n",
              (unsigned long long)last_acked, (unsigned long long)r.last_seq,
              (unsigned long long)r.dropped_bytes);
}

int main() {
  std::string why;
  if (!UringWriter::supported(&why)) {
    std::printf("skipped: %s\n", why.c_str());
    return 77;
  }
  // Mostly on a real file system: /tmp may be tmpfs on some machines.
  char tmpl[] = "uring_wal_XXXXXX";
  std::string dir = mkdtemp(tmpl);
  test_same_bytes_and_state(dir);
  test_switching_backend_on_one_file(dir);
  test_errors_are_reported(dir);
  test_kill_writer(dir);
  std::string cmd = "rm -rf " + dir;
  if (std::system(cmd.c_str()) != 0) std::fprintf(stderr, "could not remove %s\n", dir.c_str());
  return finish("uring_wal_test");
}
