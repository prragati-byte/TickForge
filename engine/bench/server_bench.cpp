// Whole-server benchmark: starts engine_server once per configuration and drives
// it over TCP. Used to compare engine flags with the same load.
//
//   server_bench --server <engine_server> --dir <directory for WAL files>
//                [--conns 4] [--orders 200000] [--runs 5] [--rate 0]
//                --config "name=flags" --config "name=flags" ...
//
// Each connection sends one order and waits for its ack before the next (closed
// loop). With --rate R, the connections together send R orders per second instead
// of as fast as possible, so the matcher has time to empty its queue; without
// it the numbers show saturation. RTT is that wait: parse, checks, WAL write, ack, client wake-up. The
// matcher columns are the server's own stats: queue push to matching finished.
// Configurations take turns within each round, so slow drift of the machine hits
// them equally. Reported values are medians over the runs. Output is markdown.
#include <algorithm>
#include <arpa/inet.h>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <random>
#include <sstream>
#include <string>
#include <sys/socket.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <vector>

using Clock = std::chrono::steady_clock;

struct Config {
  std::string name;
  std::vector<std::string> flags;
};

struct Run {
  double orders_per_sec = 0;
  double rtt_p50 = 0, rtt_p99 = 0, rtt_p999 = 0; // microseconds
  double match_p50 = 0, match_p99 = 0;           // microseconds, from the server's stats
};

static std::vector<std::string> split_words(const std::string &s) {
  std::istringstream in(s);
  std::vector<std::string> out;
  std::string w;
  while (in >> w) out.push_back(w);
  return out;
}

static pid_t start_server(const std::string &exe, int port, const std::string &wal,
                          const std::vector<std::string> &flags) {
  pid_t pid = fork();
  if (pid == 0) {
    if (!std::freopen("/dev/null", "w", stderr)) _exit(126);
    std::vector<std::string> args = {exe, "--port", std::to_string(port), "--wal", wal};
    args.insert(args.end(), flags.begin(), flags.end());
    std::vector<char *> argv;
    for (auto &a : args) argv.push_back(&a[0]);
    argv.push_back(nullptr);
    execv(exe.c_str(), argv.data());
    _exit(127);
  }
  return pid;
}

static int connect_to(int port) {
  for (int i = 0; i < 200; i++) {
    int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons(static_cast<uint16_t>(port));
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (::connect(fd, reinterpret_cast<sockaddr *>(&a), sizeof(a)) == 0) {
      int one = 1;
      ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
      return fd;
    }
    ::close(fd);
    usleep(25 * 1000);
  }
  std::fprintf(stderr, "server_bench: cannot connect to port %d\n", port);
  std::exit(1);
}

// Send orders on one connection, wait for each ack. Trade lines are read and ignored.
static void client_loop(int fd, int seed, int orders, int64_t gap_ns, std::vector<float> &rtt_us) {
  std::mt19937 rng(seed);
  std::string buf;
  char tmp[65536];
  char msg[160];
  rtt_us.reserve(orders);
  auto next = Clock::now();
  for (int ref = 0; ref < orders; ref++) {
    if (gap_ns > 0) { // spin, because a sleep is far too coarse at this scale
      while (Clock::now() < next) {}
      next += std::chrono::nanoseconds(gap_ns);
    }
    int len = std::snprintf(msg, sizeof(msg),
                            "{\"type\":\"new_order\",\"client_ref\":%d,\"symbol_id\":%u,\"side\":\"%s\","
                            "\"price\":%u,\"qty\":%u}\n",
                            ref, static_cast<unsigned>(1 + rng() % 3), rng() % 2 ? "BUY" : "SELL",
                            static_cast<unsigned>(9900 + rng() % 201),
                            static_cast<unsigned>(1 + rng() % 100));
    auto t0 = Clock::now();
    if (::send(fd, msg, len, MSG_NOSIGNAL) != len) {
      std::fprintf(stderr, "server_bench: send failed\n");
      std::exit(1);
    }
    std::string want = "\"client_ref\":" + std::to_string(ref) + ",";
    for (bool done = false; !done;) {
      size_t pos;
      while ((pos = buf.find('\n')) != std::string::npos) {
        if (buf.compare(0, 16, "{\"type\":\"trade\",") != 0 && buf.find(want) < pos) done = true;
        buf.erase(0, pos + 1);
        if (done) break;
      }
      if (done) break;
      ssize_t n = ::recv(fd, tmp, sizeof(tmp), 0);
      if (n <= 0) {
        std::fprintf(stderr, "server_bench: connection lost\n");
        std::exit(1);
      }
      buf.append(tmp, static_cast<size_t>(n));
    }
    rtt_us.push_back(std::chrono::duration<float, std::micro>(Clock::now() - t0).count());
  }
}

static double json_number(const std::string &line, const char *key) {
  std::string k = std::string("\"") + key + "\":";
  size_t p = line.find(k);
  return p == std::string::npos ? 0 : std::atof(line.c_str() + p + k.size());
}

// Wait until every order was matched, then read the server's stats.
static std::string final_stats(int fd, uint64_t expected) {
  std::string buf;
  char tmp[65536];
  const std::string ask = "{\"type\":\"command\",\"name\":\"stats\"}\n";
  for (;;) {
    if (::send(fd, ask.data(), ask.size(), MSG_NOSIGNAL) < 0) return "";
    for (;;) {
      size_t pos;
      std::string found;
      while ((pos = buf.find('\n')) != std::string::npos) {
        if (buf.compare(0, 16, "{\"type\":\"stats\",") == 0) found = buf.substr(0, pos);
        buf.erase(0, pos + 1);
      }
      if (!found.empty()) {
        if (static_cast<uint64_t>(json_number(found, "processed")) >= expected) return found;
        break;
      }
      ssize_t n = ::recv(fd, tmp, sizeof(tmp), 0);
      if (n <= 0) return "";
      buf.append(tmp, static_cast<size_t>(n));
    }
    usleep(10 * 1000);
  }
}

static double percentile(std::vector<float> &v, double p) {
  size_t i = std::min(v.size() - 1, static_cast<size_t>(v.size() * p));
  std::nth_element(v.begin(), v.begin() + i, v.end());
  return v[i];
}

static Run run_once(const std::string &exe, const std::string &dir, const Config &cfg, int conns,
                    int orders, int rate, int port) {
  std::string wal = dir + "/bench-" + std::to_string(getpid()) + ".wal";
  ::unlink(wal.c_str());
  pid_t server = start_server(exe, port, wal, cfg.flags);
  std::vector<int> fds;
  for (int i = 0; i < conns; i++) fds.push_back(connect_to(port));

  const int per_conn = orders / conns;
  const int64_t gap_ns = rate > 0 ? static_cast<int64_t>(1e9 * conns / rate) : 0;
  std::vector<std::vector<float>> samples(conns);
  auto t0 = Clock::now();
  std::vector<std::thread> clients;
  for (int i = 0; i < conns; i++)
    clients.emplace_back(client_loop, fds[i], 1000 + i, per_conn, gap_ns, std::ref(samples[i]));
  for (auto &t : clients) t.join();
  double secs = std::chrono::duration<double>(Clock::now() - t0).count();

  std::string stats = final_stats(fds[0], static_cast<uint64_t>(per_conn) * conns);
  for (int fd : fds) ::close(fd);
  kill(server, SIGTERM);
  waitpid(server, nullptr, 0);
  ::unlink(wal.c_str());

  std::vector<float> all;
  for (auto &s : samples) all.insert(all.end(), s.begin(), s.end());
  Run r;
  r.orders_per_sec = all.size() / secs;
  r.rtt_p50 = percentile(all, 0.50);
  r.rtt_p99 = percentile(all, 0.99);
  r.rtt_p999 = percentile(all, 0.999);
  r.match_p50 = json_number(stats, "p50_latency_us");
  r.match_p99 = json_number(stats, "p99_latency_us");
  return r;
}

static double median(std::vector<double> v) {
  std::sort(v.begin(), v.end());
  return v[v.size() / 2];
}

int main(int argc, char **argv) {
  std::string exe, dir;
  int conns = 4, orders = 200000, runs = 5, rate = 0;
  std::vector<Config> configs;
  for (int i = 1; i + 1 < argc; i += 2) {
    std::string a = argv[i], v = argv[i + 1];
    if (a == "--server") exe = v;
    else if (a == "--dir") dir = v;
    else if (a == "--conns") conns = std::atoi(v.c_str());
    else if (a == "--orders") orders = std::atoi(v.c_str());
    else if (a == "--runs") runs = std::atoi(v.c_str());
    else if (a == "--rate") rate = std::atoi(v.c_str());
    else if (a == "--config") {
      size_t eq = v.find('=');
      if (eq == std::string::npos) {
        std::fprintf(stderr, "--config needs name=flags\n");
        return 2;
      }
      configs.push_back({v.substr(0, eq), split_words(v.substr(eq + 1))});
    } else {
      std::fprintf(stderr, "unknown option %s\n", a.c_str());
      return 2;
    }
  }
  if (exe.empty() || dir.empty() || configs.empty() || conns < 1 || orders < conns || runs < 1) {
    std::fprintf(stderr, "usage: server_bench --server <exe> --dir <dir> --config name=flags ...\n");
    return 2;
  }
  std::signal(SIGPIPE, SIG_IGN);

  std::map<std::string, std::vector<Run>> results;
  int port = 42000 + getpid() % 10000;
  for (int r = 0; r < runs; r++)
    for (const Config &c : configs) results[c.name].push_back(run_once(exe, dir, c, conns, orders, rate, port));

  std::printf("%d connections, %d orders per run, %d runs per configuration, %s. "
              "Median over the runs; throughput also shows the slowest and fastest run.\n\n",
              conns, orders, runs,
              rate > 0 ? ("paced at " + std::to_string(rate) + " orders/s in total").c_str()
                       : "closed loop, as fast as possible");
  std::printf("| Configuration | Throughput (orders/s) | Range | RTT P50 (us) | RTT P99 (us) | "
              "RTT P99.9 (us) | Matcher P50 (us) | Matcher P99 (us) | Matcher P99 range |\n");
  std::printf("|---|---|---|---|---|---|---|---|---|\n");
  for (const Config &c : configs) {
    std::vector<double> tp, p50, p99, p999, m50, m99;
    for (const Run &x : results[c.name]) {
      tp.push_back(x.orders_per_sec);
      p50.push_back(x.rtt_p50);
      p99.push_back(x.rtt_p99);
      p999.push_back(x.rtt_p999);
      m50.push_back(x.match_p50);
      m99.push_back(x.match_p99);
    }
    std::printf("| %s | %.0f | %.0f to %.0f | %.1f | %.1f | %.1f | %.1f | %.1f | %.0f to %.0f |\n",
                c.name.c_str(), median(tp), *std::min_element(tp.begin(), tp.end()),
                *std::max_element(tp.begin(), tp.end()), median(p50), median(p99), median(p999),
                median(m50), median(m99), *std::min_element(m99.begin(), m99.end()),
                *std::max_element(m99.begin(), m99.end()));
  }
  return 0;
}
