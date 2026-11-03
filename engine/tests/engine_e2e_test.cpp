// End-to-end test: start engine_server, talk to it over TCP, kill -9 it,
// start it again on the same WAL and check that the state hash is identical.
//
//   engine_e2e_test <path to engine_server> [engine flags...]
#include "test_client.hpp"

#include <csignal>
#include <cstdlib>
#include <random>
#include <string>
#include <sys/wait.h>
#include <unistd.h>
#include <vector>

// ---- server process ---------------------------------------------------------

static std::vector<std::string> g_flags; // extra engine flags from the command line

static pid_t start_server(const char *exe, int port, const std::string &wal) {
  pid_t pid = fork();
  if (pid == 0) {
    std::vector<std::string> args = {exe, "--port", std::to_string(port), "--wal", wal};
    args.insert(args.end(), g_flags.begin(), g_flags.end());
    std::vector<char *> argv;
    for (auto &a : args) argv.push_back(&a[0]);
    argv.push_back(nullptr);
    execv(exe, argv.data());
    _exit(127);
  }
  return pid;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: engine_e2e_test <engine_server>\n");
    return 2;
  }
  const char *exe = argv[1];
  g_flags.assign(argv + 2, argv + argc);
  char tmpl[] = "/tmp/tf_e2e_XXXXXX";
  std::string dir = mkdtemp(tmpl);
  std::string wal = dir + "/engine.wal";
  int port = 20000 + getpid() % 20000;

  // ---- first run ----
  pid_t server = start_server(exe, port, wal);
  Client a, b;
  CHECK(a.connect_to(port));
  CHECK(b.connect_to(port));

  // resting asks, then a buy that crosses part of the first one
  JsonObject r = a.request(order_json(1, 1, "SELL", 10000, 100), 1);
  CHECK(reason_of(r) == "(ack)");
  int64_t first_id = 0;
  CHECK(get_int(r, "order_id", first_id) && first_id == 1);
  a.request(order_json(2, 1, "SELL", 10010, 50), 2);
  r = a.request(order_json(3, 1, "BUY", 10000, 60), 3);
  CHECK(reason_of(r) == "(ack)");

  // both clients see the trade
  JsonObject t;
  CHECK(parse_json_object(b.read_type("trade"), t));
  int64_t trade_id = 0, price = 0, qty = 0, buy = 0, sell = 0;
  CHECK(get_int(t, "trade_id", trade_id) && trade_id == 1);
  CHECK(get_int(t, "price", price) && price == 10000); // the resting order's price
  CHECK(get_int(t, "qty", qty) && qty == 60);
  CHECK(get_int(t, "buy_order_id", buy) && buy == 3);
  CHECK(get_int(t, "sell_order_id", sell) && sell == 1);

  // rejects
  CHECK(reason_of(a.request(order_json(10, 1, "BUY", 10000, 20000), 10)) == "max_qty");
  CHECK(reason_of(a.request(order_json(11, 0, "BUY", 10000, 10), 11)) == "unknown_symbol");
  CHECK(reason_of(a.request(order_json(12, 1, "BUY", 13000, 10), 12)) == "price_band");
  CHECK(reason_of(a.request(
            "{\"type\":\"new_order\",\"client_ref\":13,\"symbol_id\":1,\"side\":\"BUY\","
            "\"price\":100.5,\"qty\":10}",
            13)) == "bad_request");
  a.send("this is not json");
  CHECK(extract(a.read_type("reject"), "reason") == "\"bad_request\"");

  // cancel: ok once, then unknown
  r = a.request(order_json(20, 1, "BUY", 9500, 10), 20);
  int64_t bid_id = 0;
  CHECK(get_int(r, "order_id", bid_id));
  std::string cancel = "{\"type\":\"cancel\",\"client_ref\":21,\"order_id\":" + std::to_string(bid_id) + "}";
  r = a.request(cancel, 21);
  CHECK(reason_of(r) == "(ack)");
  int64_t cid = 0;
  CHECK(get_int(r, "order_id", cid) && cid == bid_id);
  CHECK(reason_of(a.request(
            "{\"type\":\"cancel\",\"client_ref\":22,\"order_id\":" + std::to_string(bid_id) + "}",
            22)) == "unknown_order");
  CHECK(reason_of(a.request("{\"type\":\"cancel\",\"client_ref\":23,\"order_id\":999999}", 23)) ==
        "unknown_order");

  // a few hundred random orders for a richer book
  std::mt19937 rng(7);
  for (int i = 0; i < 300; i++) {
    int ref = 100 + i;
    JsonObject x = a.request(
        order_json(ref, 1 + rng() % 3, rng() % 2 ? "BUY" : "SELL", 9800 + rng() % 400, 1 + rng() % 100), ref);
    (void)x;
  }

  // book snapshot
  std::string book = a.ask("{\"type\":\"command\",\"name\":\"book\",\"symbol_id\":2,\"depth\":5}", "book");
  CHECK(book.find("\"symbol_id\":2") != std::string::npos);
  CHECK(book.find("\"bids\":[") != std::string::npos && book.find("\"asks\":[") != std::string::npos);

  // stats
  std::string stats = a.ask("{\"type\":\"command\",\"name\":\"stats\"}", "stats");
  for (const char *key : {"uptime_s", "submitted", "processed", "queue_depth", "orders_per_sec",
                          "trades_total", "trades_per_sec", "avg_latency_us", "p50_latency_us",
                          "p99_latency_us", "lat_hist", "producers", "threads", "cpu_pct",
                          "rss_mb", "last_seq", "state_hash"})
    CHECK(stats.find(std::string("\"") + key + "\":") != std::string::npos);
  CHECK(std::atoi(extract(stats, "processed").c_str()) >= 300);
  CHECK(std::atoi(extract(stats, "threads").c_str()) >= 3);
  std::printf("  stats: %s\n", stats.c_str());

  // state before the crash
  std::string h1 = a.ask("{\"type\":\"command\",\"name\":\"state_hash\"}", "state_hash");
  std::string book1 = a.ask("{\"type\":\"command\",\"name\":\"book\",\"symbol_id\":1,\"depth\":50}", "book");
  CHECK(!extract(h1, "hash").empty());

  // ---- crash ----
  kill(server, SIGKILL);
  waitpid(server, nullptr, 0);
  ::close(a.fd);
  ::close(b.fd);

  // ---- second run on the same WAL ----
  server = start_server(exe, port, wal);
  Client c;
  CHECK(c.connect_to(port));
  std::string h2 = c.ask("{\"type\":\"command\",\"name\":\"state_hash\"}", "state_hash");
  std::string book2 = c.ask("{\"type\":\"command\",\"name\":\"book\",\"symbol_id\":1,\"depth\":50}", "book");
  std::printf("  before crash: %s\n  after restart: %s\n", h1.c_str(), h2.c_str());
  CHECK(h1 == h2);
  CHECK(book1 == book2);

  // numbering continues after the last logged seq
  r = c.request(order_json(900, 1, "BUY", 9000, 1), 900);
  int64_t next_id = 0;
  CHECK(get_int(r, "order_id", next_id));
  CHECK(next_id == std::atoll(extract(h1, "last_seq").c_str()) + 1);

  kill(server, SIGTERM);
  waitpid(server, nullptr, 0);
  std::string cmd = "rm -rf " + dir;
  if (std::system(cmd.c_str()) != 0) std::fprintf(stderr, "could not remove %s\n", dir.c_str());
  return finish("engine_e2e_test");
}
