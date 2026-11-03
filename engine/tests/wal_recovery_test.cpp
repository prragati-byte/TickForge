// WAL tests:
//   1. replay gives the same state hash as the live exchange
//   2. a file cut at ANY byte recovers to a clean prefix and is truncated
//   3. a corrupt frame stops recovery at that frame
//   4. a writer process killed with SIGKILL leaves a log that recovers
#include "map_book.hpp"
#include "replay.hpp"
#include "test_util.hpp"

#include <csignal>
#include <cstdio>
#include <fstream>
#include <random>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

// A reproducible list of inputs: mostly orders, some cancels.
static std::vector<WalRecord> make_records(int n, uint32_t seed) {
  std::mt19937 rng(seed);
  std::vector<WalRecord> out;
  for (int i = 1; i <= n; i++) {
    WalRecord r;
    r.seq = i;
    r.ts_ms = 1700000000000ULL + i;
    if (i > 5 && rng() % 100 < 15) {
      r.type = WalRecord::Cancel;
      r.order_id = 1 + rng() % (i - 1);
    } else {
      r.type = WalRecord::NewOrder;
      r.order_id = i;
      r.symbol_id = 1 + rng() % 3;
      r.side = rng() % 2;
      r.price = 18900 + rng() % 100;
      r.qty = 1 + rng() % 100;
    }
    out.push_back(r);
  }
  return out;
}

// Hash of an exchange that was fed the first `count` records directly.
static uint64_t live_hash(const std::vector<WalRecord> &recs, size_t count) {
  Exchange<MapBook> ex;
  std::vector<Trade> t;
  for (size_t i = 0; i < count; i++) {
    t.clear();
    apply_record(ex, recs[i], t);
  }
  return ex.state_hash();
}

static void write_wal(const std::string &path, const std::vector<WalRecord> &recs) {
  std::remove(path.c_str());
  wal_recover(path, [](const WalRecord &) {}); // creates the header
  WalWriter w(path);
  for (const WalRecord &r : recs) w.append(r);
}

static std::string read_file(const std::string &path) {
  std::ifstream f(path, std::ios::binary);
  return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

static void write_file(const std::string &path, const std::string &data) {
  std::ofstream f(path, std::ios::binary | std::ios::trunc);
  f.write(data.data(), static_cast<std::streamsize>(data.size()));
}

static long file_size(const std::string &path) {
  struct stat st;
  return ::stat(path.c_str(), &st) == 0 ? static_cast<long>(st.st_size) : -1;
}

static void test_replay_equals_live(const std::string &dir) {
  std::string path = dir + "/replay.wal";
  auto recs = make_records(5000, 1);
  write_wal(path, recs);

  Exchange<MapBook> ex;
  WalRecovery r = recover_exchange(path, ex);
  CHECK(r.records == 5000);
  CHECK(r.last_seq == 5000);
  CHECK(r.dropped_bytes == 0);
  CHECK(ex.state_hash() == live_hash(recs, recs.size()));
}

static void test_cut_at_every_byte(const std::string &dir) {
  std::string path = dir + "/cut.wal";
  auto recs = make_records(40, 2);
  write_wal(path, recs);
  const std::string full = read_file(path);

  // End offset of every frame, so we know which prefix each cut should keep.
  std::vector<size_t> ends;
  size_t pos = 8;
  for (const WalRecord &r : recs) {
    pos += wal_encode_frame(r).size();
    ends.push_back(pos);
  }
  CHECK(pos == full.size());

  for (size_t cut = 0; cut <= full.size(); cut++) {
    write_file(path, full.substr(0, cut));
    size_t good = 0; // complete frames inside the first `cut` bytes
    while (good < ends.size() && ends[good] <= cut) good++;

    Exchange<MapBook> ex;
    WalRecovery r = recover_exchange(path, ex);
    CHECK(r.records == good);
    CHECK(ex.state_hash() == live_hash(recs, good));
    size_t expected_size = good == 0 ? 8 : ends[good - 1];
    CHECK(file_size(path) == static_cast<long>(expected_size)); // truncated to the last good frame
    if (failure_count() > 0) {
      std::fprintf(stderr, "failed at cut=%zu\n", cut);
      return;
    }
  }
}

static void test_corrupt_frame(const std::string &dir) {
  std::string path = dir + "/corrupt.wal";
  auto recs = make_records(30, 3);
  write_wal(path, recs);
  std::string data = read_file(path);

  size_t frame10 = 8;
  for (int i = 0; i < 10; i++) frame10 += wal_encode_frame(recs[i]).size();
  data[frame10 + 8 + 3] ^= 0x40; // flip one payload bit in the 11th frame
  write_file(path, data);

  Exchange<MapBook> ex;
  WalRecovery r = recover_exchange(path, ex);
  CHECK(r.records == 10);
  CHECK(ex.state_hash() == live_hash(recs, 10));
  CHECK(file_size(path) == static_cast<long>(frame10));
}

static void test_bad_header(const std::string &dir) {
  std::string path = dir + "/notwal.wal";
  write_file(path, "this is not a wal file at all");
  bool threw = false;
  try {
    wal_recover(path, [](const WalRecord &) {});
  } catch (const std::exception &) {
    threw = true;
  }
  CHECK(threw);
  CHECK(read_file(path) == "this is not a wal file at all"); // left untouched
}

// A child process appends records as fast as it can; the parent kills it.
static void test_kill_writer(const std::string &dir) {
  std::string path = dir + "/kill.wal";
  std::remove(path.c_str());
  wal_recover(path, [](const WalRecord &) {});

  pid_t pid = fork();
  if (pid == 0) {
    WalWriter w(path);
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
    }
  }
  usleep(150 * 1000);
  kill(pid, SIGKILL);
  waitpid(pid, nullptr, 0);

  uint64_t expect = 1;
  bool in_order = true;
  Exchange<MapBook> ex1;
  std::vector<Trade> t;
  WalRecovery r1 = wal_recover(path, [&](const WalRecord &rec) {
    in_order = in_order && rec.seq == expect++;
    t.clear();
    apply_record(ex1, rec, t);
  });
  CHECK(r1.records > 0);
  CHECK(in_order); // frames are consecutive, nothing missing or doubled
  CHECK(r1.last_seq == r1.records);

  // Recovering again finds a clean file and the same state.
  Exchange<MapBook> ex2;
  WalRecovery r2 = recover_exchange(path, ex2);
  CHECK(r2.records == r1.records && r2.dropped_bytes == 0);
  CHECK(ex1.state_hash() == ex2.state_hash());
  std::printf("  killed writer left %llu good records, %llu dropped bytes\n",
              (unsigned long long)r1.records, (unsigned long long)r1.dropped_bytes);
}

int main() {
  char tmpl[] = "/tmp/tf_wal_test_XXXXXX";
  std::string dir = mkdtemp(tmpl);

  test_replay_equals_live(dir);
  test_cut_at_every_byte(dir);
  test_corrupt_frame(dir);
  test_bad_header(dir);
  test_kill_writer(dir);

  std::string cmd = "rm -rf " + dir;
  if (std::system(cmd.c_str()) != 0) std::fprintf(stderr, "could not remove %s\n", dir.c_str());
  return finish("wal_recovery_test");
}
