// WAL crash-recovery tests. Run: ctest  (or ./wal_recovery_test)
#include "wal/wal_database.hpp"
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>

static int failures = 0;
#define CHECK(cond)                                                            \
  do {                                                                         \
    if (!(cond)) {                                                             \
      std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << "  " #cond "\n";  \
      failures++;                                                              \
    }                                                                          \
  } while (0)

static std::string fresh(const char *name) {
  std::string p = (std::filesystem::temp_directory_path() / name).string();
  std::remove(p.c_str());
  return p;
}

static void append_raw(const std::string &path, const std::string &text) {
  std::ofstream f(path, std::ios::app | std::ios::binary);
  f << text;
}

static Trade make_trade(uint64_t id, double price) {
  return Trade{id, 101, price, 10, 5001, 5002};
}

static void test_roundtrip() {
  auto path = fresh("tf_wal_roundtrip.log");
  {
    wal::WalDatabase db(path, false);
    CHECK(db.set_value("exchange_status", "RUNNING"));
    CHECK(db.set_value("note", "has|pipe|inside")); // '|' ok in value
    CHECK(db.add_trade(make_trade(0, 150.25)));
    CHECK(db.add_trade(make_trade(1, 0.1 + 0.2))); // needs exact double roundtrip
  }
  wal::WalDatabase db(path, false);
  CHECK(db.state().kv.at("exchange_status") == "RUNNING");
  CHECK(db.state().kv.at("note") == "has|pipe|inside");
  CHECK(db.state().trades.size() == 2);
  CHECK(db.state().trades[0].price == 150.25);
  CHECK(db.state().trades[1].price == 0.1 + 0.2);
  CHECK(db.next_trade_id() == 2);
}

static void test_uncommitted_ignored() {
  auto path = fresh("tf_wal_uncommitted.log");
  {
    wal::WalDatabase db(path, false);
    CHECK(db.add_trade(make_trade(0, 100.0)));
  }
  append_raw(path, "BEGIN|50\nTRADE|1|101|99.5|5|1|2\n"); // crash before COMMIT
  wal::WalDatabase db(path, false);
  CHECK(db.state().trades.size() == 1);
  CHECK(db.recovery_stats().discarded_txns == 1);
  // txid 50 must never be reused
  CHECK(db.add_trade(make_trade(1, 101.0)));
  wal::WalDatabase db2(path, false);
  CHECK(db2.state().trades.size() == 2);
}

static void test_torn_tail_repaired() {
  auto path = fresh("tf_wal_torn.log");
  {
    wal::WalDatabase db(path, false);
    CHECK(db.add_trade(make_trade(0, 100.0)));
  }
  append_raw(path, "BEGIN|7\nTRADE|1|101|150.2"); // cut mid-line, no newline
  {
    wal::WalDatabase db(path, false);
    CHECK(db.recovery_stats().torn_tail_repaired);
    CHECK(db.state().trades.size() == 1);
    CHECK(db.add_trade(make_trade(1, 102.0))); // must not glue onto the fragment
  }
  wal::WalDatabase db(path, false);
  CHECK(db.state().trades.size() == 2);
  CHECK(db.state().trades[1].price == 102.0);
}

static void test_torn_commit_not_committed() {
  auto path = fresh("tf_wal_torn_commit.log");
  append_raw(path, "BEGIN|1\nTRADE|0|101|100|5|1|2\nCOMMIT|1"); // no '\n'
  wal::WalDatabase db(path, false);
  CHECK(db.state().trades.empty());
}

static void test_garbage_does_not_crash() {
  auto path = fresh("tf_wal_garbage.log");
  append_raw(path,
             "BEGIN|abc\n"                      // malformed BEGIN
             "STRAY|1\n"                        // outside any tx
             "BEGIN|2\nTRADE|x|y|z\nSET|k|v\nCOMMIT|2\n" // bad record + good one
             "COMMIT|9\n");                     // commit without begin
  wal::WalDatabase db(path, false);
  CHECK(db.state().kv.at("k") == "v");
  CHECK(db.state().trades.empty());
  CHECK(db.recovery_stats().malformed_records == 1);
}

static void test_rejects_bad_keys() {
  auto path = fresh("tf_wal_badkey.log");
  wal::WalDatabase db(path, false);
  CHECK(!db.set_value("a|b", "v"));
  CHECK(!db.set_value("", "v"));
  CHECK(!db.set_value("k", "line1\nline2"));
  CHECK(db.state().kv.empty());
}

int main() {
  test_roundtrip();
  test_uncommitted_ignored();
  test_torn_tail_repaired();
  test_torn_commit_not_committed();
  test_garbage_does_not_crash();
  test_rejects_bad_keys();
  if (failures == 0) std::cout << "All WAL tests passed\n";
  return failures == 0 ? 0 : 1;
}
