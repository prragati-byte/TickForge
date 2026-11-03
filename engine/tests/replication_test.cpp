// Leader to follower WAL shipping on localhost, with real server processes.
//
//   replication_test <path to engine_server> [engine flags for both nodes...]
//
// "The same state" means: the same state hash, the same book, and a byte-identical
// WAL file. Crashes are real: kill -9 on either node, mid-stream.
#include "test_client.hpp"
#include "wal.hpp"

#include <atomic>
#include <csignal>
#include <cstdlib>
#include <fstream>
#include <random>
#include <sstream>
#include <string>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <vector>

static const char *g_exe;
static std::vector<std::string> g_flags;

static pid_t start_server(int port, const std::string &wal, const std::vector<std::string> &flags) {
  pid_t pid = fork();
  if (pid == 0) {
    std::vector<std::string> args = {g_exe, "--port", std::to_string(port), "--wal", wal, "--no-pin"};
    args.insert(args.end(), g_flags.begin(), g_flags.end());
    args.insert(args.end(), flags.begin(), flags.end());
    std::vector<char *> argv;
    for (auto &a : args) argv.push_back(&a[0]);
    argv.push_back(nullptr);
    execv(g_exe, argv.data());
    _exit(127);
  }
  return pid;
}

static void kill9(pid_t pid) {
  kill(pid, SIGKILL);
  waitpid(pid, nullptr, 0);
}

static void stop(pid_t pid) {
  kill(pid, SIGTERM);
  waitpid(pid, nullptr, 0);
}

static std::string read_file(const std::string &path) {
  std::ifstream f(path, std::ios::binary);
  std::stringstream s;
  s << f.rdbuf();
  return s.str();
}

// Random orders and cancels, one at a time, each waiting for its reply.
static void send_orders(Client &c, int count, unsigned seed) {
  std::mt19937 rng(seed);
  std::vector<int64_t> ids;
  for (int i = 0; i < count; i++) {
    int ref = 1000 + i;
    if (!ids.empty() && rng() % 10 == 0) {
      c.request("{\"type\":\"cancel\",\"client_ref\":" + std::to_string(ref) +
                    ",\"order_id\":" + std::to_string(ids[rng() % ids.size()]) + "}",
                ref);
      continue;
    }
    JsonObject r = c.request(order_json(ref, 1 + rng() % 3, rng() % 2 ? "BUY" : "SELL", 9900 + rng() % 200,
                                        1 + rng() % 100),
                             ref);
    int64_t id;
    if (get_int(r, "order_id", id)) ids.push_back(id);
  }
}

struct Snapshot {
  std::string hash, last_seq, book;
};

static Snapshot snapshot(Client &c) {
  Snapshot s;
  std::string line = c.ask("{\"type\":\"command\",\"name\":\"state_hash\"}", "state_hash");
  s.hash = extract(line, "hash");
  s.last_seq = extract(line, "last_seq");
  std::string book;
  for (int symbol = 1; symbol <= 3; symbol++)
    book += c.ask("{\"type\":\"command\",\"name\":\"book\",\"symbol_id\":" + std::to_string(symbol) +
                      ",\"depth\":100}",
                  "book");
  s.book = book;
  return s;
}

// Wait for the follower to catch up, then require everything to match.
static void expect_same_state(Client &leader, Client &follower, const std::string &leader_wal,
                              const std::string &follower_wal, const char *when) {
  Snapshot a = snapshot(leader);
  Snapshot b;
  for (int i = 0; i < 1000; i++) {
    b = snapshot(follower);
    if (b.last_seq == a.last_seq) break;
    usleep(10 * 1000);
  }
  std::printf("  %s: leader %s seq %s, follower %s seq %s\n", when, a.hash.c_str(), a.last_seq.c_str(),
              b.hash.c_str(), b.last_seq.c_str());
  CHECK(a.last_seq == b.last_seq);
  CHECK(!a.hash.empty());
  CHECK(a.hash == b.hash);
  CHECK(a.book == b.book);
  CHECK(read_file(leader_wal) == read_file(follower_wal));
  // Reconnecting would hide a bad stream, so the state alone does not prove it was clean.
  std::string stats = follower.ask("{\"type\":\"command\",\"name\":\"stats\"}", "stats");
  CHECK(stats.find("\"damaged_frames\":0") != std::string::npos);
}

static WalRecord order_record(uint64_t seq, int64_t price) {
  WalRecord r;
  r.seq = seq;
  r.ts_ms = 1000 + seq;
  r.order_id = seq;
  r.symbol_id = 1;
  r.side = 0;
  r.price = price;
  r.qty = 10;
  return r;
}

static void write_wal_file(const std::string &path, const std::vector<WalRecord> &recs) {
  std::remove(path.c_str());
  wal_recover(path, [](const WalRecord &) {});
  WalWriter w(path);
  for (const WalRecord &r : recs) w.append(r);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: replication_test <engine_server> [flags]\n");
    return 2;
  }
  std::signal(SIGPIPE, SIG_IGN);
  g_exe = argv[1];
  g_flags.assign(argv + 2, argv + argc);
  char tmpl[] = "/tmp/tf_repl_XXXXXX";
  std::string dir = mkdtemp(tmpl);
  const int lport = 20000 + getpid() % 20000, fport = lport + 1;
  const std::string lwal = dir + "/leader.wal", fwal = dir + "/follower.wal";
  const std::string follow = "127.0.0.1:" + std::to_string(lport);

  { // Off by default: a server without --replicate refuses, as it always did.
    pid_t s = start_server(lport, dir + "/off.wal", {});
    Client c;
    CHECK(c.connect_to(lport));
    c.send("{\"type\":\"replicate\",\"client_ref\":5,\"after_seq\":0,\"after_crc\":0}");
    CHECK(extract(c.read_type("reject"), "reason") == "\"bad_request\"");
    ::close(c.fd);
    stop(s);
  }

  { // A follower of a server without --replicate stops with an error instead of waiting.
    pid_t l = start_server(lport, dir + "/off2.wal", {});
    Client c;
    CHECK(c.connect_to(lport));
    pid_t f = start_server(fport, dir + "/f2.wal", {"--follow", follow});
    int status = 0;
    waitpid(f, &status, 0);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 3);
    ::close(c.fd);
    stop(l);
  }

  pid_t leader = start_server(lport, lwal, {"--replicate"});
  Client lc;
  CHECK(lc.connect_to(lport));

  // Data that exists before the follower: it has to catch up from the file.
  send_orders(lc, 500, 1);

  pid_t follower = start_server(fport, fwal, {"--follow", follow});
  Client fc;
  CHECK(fc.connect_to(fport));
  expect_same_state(lc, fc, lwal, fwal, "after catch-up");

  // Live flow.
  send_orders(lc, 500, 2);
  expect_same_state(lc, fc, lwal, fwal, "after live orders");

  { // Several clients at once while the WAL is being shipped.
    std::vector<std::thread> threads;
    for (unsigned t = 0; t < 4; t++)
      threads.emplace_back([t, lport] {
        Client c;
        CHECK(c.connect_to(lport));
        send_orders(c, 300, 10 + t);
        ::close(c.fd);
      });
    for (auto &t : threads) t.join();
    expect_same_state(lc, fc, lwal, fwal, "after 4 clients at once");
  }

  { // A follower does not take orders, and refusing them changes nothing.
    Snapshot before = snapshot(fc);
    CHECK(reason_of(fc.request(order_json(7, 1, "BUY", 10000, 5), 7)) == "read_only");
    CHECK(reason_of(fc.request("{\"type\":\"cancel\",\"client_ref\":8,\"order_id\":1}", 8)) == "read_only");
    Snapshot after = snapshot(fc);
    CHECK(before.hash == after.hash);
    CHECK(before.last_seq == after.last_seq);
    std::string stats = fc.ask("{\"type\":\"command\",\"name\":\"stats\"}", "stats");
    CHECK(stats.find("\"role\":\"follower\"") != std::string::npos);
    stats = lc.ask("{\"type\":\"command\",\"name\":\"stats\"}", "stats");
    CHECK(stats.find("\"role\":\"leader\"") != std::string::npos);
  }

  { // kill -9 the follower while orders are arriving; it restarts from its own WAL.
    std::atomic<bool> go{true};
    std::thread load([&] {
      Client c;
      CHECK(c.connect_to(lport));
      unsigned seed = 100;
      while (go.load()) send_orders(c, 50, seed++);
      ::close(c.fd);
    });
    usleep(100 * 1000);
    kill9(follower);
    ::close(fc.fd);
    usleep(100 * 1000);
    go = false;
    load.join();
    send_orders(lc, 100, 200);
    follower = start_server(fport, fwal, {"--follow", follow});
    fc = Client();
    CHECK(fc.connect_to(fport));
    expect_same_state(lc, fc, lwal, fwal, "after kill -9 of the follower");
  }

  { // kill -9 the leader mid-stream. It recovers its own hash; the follower reconnects.
    std::atomic<bool> go{true};
    std::thread load([&] {
      Client c;
      if (!c.connect_to(lport)) return;
      for (int ref = 0; go.load() && ref < 100000; ref++) {
        std::string line = order_json(ref, 1, ref % 2 ? "BUY" : "SELL", 10000, 1) + "\n";
        // Not Client::send, which treats a failure as a test failure: here the leader dies.
        if (::send(c.fd, line.data(), line.size(), MSG_NOSIGNAL) < 0) break;
        if (c.read_line().empty()) break;
      }
      ::close(c.fd);
    });
    usleep(100 * 1000);
    kill9(leader);
    go = false;
    load.join();
    ::close(lc.fd);

    leader = start_server(lport, lwal, {"--replicate"});
    lc = Client();
    CHECK(lc.connect_to(lport));
    expect_same_state(lc, fc, lwal, fwal, "after kill -9 of the leader");
    send_orders(lc, 200, 300);
    expect_same_state(lc, fc, lwal, fwal, "after more orders on the restarted leader");
  }

  { // Manual promotion: the same WAL without --follow is a normal server.
    Snapshot before = snapshot(fc);
    ::close(fc.fd);
    stop(follower);
    follower = start_server(fport, fwal, {});
    fc = Client();
    CHECK(fc.connect_to(fport));
    Snapshot after = snapshot(fc);
    CHECK(before.hash == after.hash);
    JsonObject r = fc.request(order_json(9, 1, "BUY", 9000, 1), 9);
    CHECK(reason_of(r) == "(ack)");
    int64_t id = 0;
    CHECK(get_int(r, "order_id", id) && id == std::atoll(before.last_seq.c_str()) + 1);
    ::close(fc.fd);
    stop(follower);
  }
  ::close(lc.fd);
  stop(leader);

  { // A follower ahead of the leader, and one with different history, must refuse to run.
    std::vector<WalRecord> common = {order_record(1, 10000), order_record(2, 10001)};
    write_wal_file(dir + "/short.wal", common);
    std::vector<WalRecord> longer = common;
    longer.push_back(order_record(3, 10002));
    write_wal_file(dir + "/long.wal", longer);
    std::vector<WalRecord> other = {order_record(1, 10000), order_record(2, 12345)};
    write_wal_file(dir + "/other.wal", other);

    pid_t l = start_server(lport, dir + "/short.wal", {"--replicate"});
    Client c;
    CHECK(c.connect_to(lport));

    pid_t f = start_server(fport, dir + "/long.wal", {"--follow", follow});
    int status = 0;
    waitpid(f, &status, 0);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 3);

    f = start_server(fport, dir + "/other.wal", {"--follow", follow});
    status = 0;
    waitpid(f, &status, 0);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 3);

    ::close(c.fd);
    stop(l);
  }

  std::string cmd = "rm -rf " + dir;
  if (std::system(cmd.c_str()) != 0) std::fprintf(stderr, "could not remove %s\n", dir.c_str());
  return finish("replication_test");
}
