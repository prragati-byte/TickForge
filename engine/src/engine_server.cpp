// engine_server: the TickForge matching engine as a TCP server.
//
//   engine_server --port 9100 --wal data/engine.wal [--max-qty 10000] [--band-pct 20]
//                 [--pin | --no-pin] [--pin-core N]
//                 [--queue lockfree|elastic] [--ring-size 65536]
//                 [--wal-io write|uring]
//                 [--replicate | --follow HOST:PORT]
//
// Protocol: one JSON object per line (see docs/CONTRACTS.md, section 2).
//
// Threads
//   main        accepts connections
//   connection  one per client (a "producer"): parse, check, write the WAL,
//               ack, push onto the queue
//   matcher     the only thread that touches the order books
//   follower    with --follow: reads WAL frames from the leader, logs them and
//               queues them for the matcher, just like orders from a client
//
// A connection that sends {"type":"replicate"} to a leader becomes a WAL stream:
// its thread reads the leader's WAL file and sends each complete frame, so a slow
// follower never holds up the critical path. See docs/CONTRACTS.md, section 2.
//
// The order books are MapBook (std::map). DenseBook is not used here because
// it only accepts prices inside a fixed range.
#include "affinity.hpp"
#include "elastic_ring.hpp"
#include "json_lite.hpp"
#include "lock_free_queue.hpp"
#include "map_book.hpp"
#include "replay.hpp"
#include "uring.hpp"
#include "wal.hpp"

#include <algorithm>
#include <arpa/inet.h>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <fcntl.h>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pthread.h>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>
#include <vector>

using Clock = std::chrono::steady_clock;

static int64_t now_ns() {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now().time_since_epoch())
      .count();
}
static uint64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

static std::atomic<bool> g_stop{false};
static void on_signal(int) { g_stop.store(true); }

// ---- queue items and connections --------------------------------------------

// One unit of work for the matching thread.
struct Job {
  enum Kind : uint8_t { NewOrder, Cancel, BookCmd, StatsCmd, HashCmd };
  Kind kind = NewOrder;
  uint32_t conn_id = 0; // who gets the reply
  int64_t client_ref = 0;
  Order order;              // NewOrder; for Cancel only .seq is used
  uint64_t cancel_id = 0;   // Cancel
  uint32_t depth = 0;       // BookCmd (symbol is in order.symbol_id)
  int64_t pushed_ns = 0;    // when the connection thread pushed it
};

struct Conn {
  int fd = -1;
  uint32_t id = 0;
  std::mutex write_mu;
  bool open = true; // guarded by write_mu
  bool replica = false; // guarded by write_mu: now carries WAL frames, not JSON lines
  std::atomic<uint64_t> *produced = nullptr; // orders this connection submitted
};

struct Options {
  int port = 9100;
  std::string wal_path;
  int64_t max_qty = 10000;
  int64_t band_pct = 20;
  bool pin = false;  // pin the matching thread to one core (--pin turns it on)
  int pin_core = -1; // -1: choose automatically
  bool elastic_queue = false; // ElasticRing instead of MPSCQueue
  size_t ring_size = 1 << 16;
  WalIo wal_io = WalIo::Write;
  bool replicate = false;    // leader: serve WAL frames to followers
  std::string follow_host;   // follower: read-only copy of this leader
  int follow_port = 0;
};

// ---- small helpers ----------------------------------------------------------

static std::string hash_hex(uint64_t h) {
  char buf[17];
  std::snprintf(buf, sizeof(buf), "%016llx", static_cast<unsigned long long>(h));
  return buf;
}

static const char *side_name(Side s) { return s == Side::Buy ? "BUY" : "SELL"; }

static std::string levels_json(const MapBook::Levels &levels) {
  std::string s = "[";
  for (size_t i = 0; i < levels.size(); i++) {
    if (i) s += ",";
    s += "[" + std::to_string(levels[i].first) + "," + std::to_string(levels[i].second) + "]";
  }
  return s + "]";
}

static std::string reject_json(int64_t ref, const char *reason) {
  return "{\"type\":\"reject\",\"client_ref\":" + std::to_string(ref) + ",\"reason\":\"" + reason +
         "\"}\n";
}

static std::string ack_json(int64_t ref, uint64_t order_id, uint64_t seq) {
  return "{\"type\":\"ack\",\"client_ref\":" + std::to_string(ref) +
         ",\"order_id\":" + std::to_string(order_id) + ",\"seq\":" + std::to_string(seq) + "}\n";
}

static std::string trade_json(const Trade &t) {
  return "{\"type\":\"trade\",\"trade_id\":" + std::to_string(t.trade_id) +
         ",\"seq\":" + std::to_string(t.seq) + ",\"symbol_id\":" + std::to_string(t.symbol_id) +
         ",\"price\":" + std::to_string(t.price) + ",\"qty\":" + std::to_string(t.qty) +
         ",\"buy_order_id\":" + std::to_string(t.buy_order_id) +
         ",\"sell_order_id\":" + std::to_string(t.sell_order_id) + ",\"taker_side\":\"" +
         side_name(t.taker_side) + "\",\"ts_ms\":" + std::to_string(t.ts_ms) + "}\n";
}

// Process numbers from /proc/self (Linux).
struct ProcInfo {
  double cpu_seconds = 0;
  double rss_mb = 0;
  int threads = 0;
};

static ProcInfo read_proc() {
  ProcInfo p;
  if (FILE *f = std::fopen("/proc/self/stat", "r")) {
    char line[1024] = {0};
    if (std::fgets(line, sizeof(line), f)) {
      // Fields after the ")" of the command name: utime is the 12th, stime the 13th.
      const char *rest = std::strrchr(line, ')');
      unsigned long utime = 0, stime = 0;
      if (rest && std::sscanf(rest + 2, "%*c %*d %*d %*d %*d %*d %*u %*u %*u %*u %*u %lu %lu",
                              &utime, &stime) == 2)
        p.cpu_seconds = static_cast<double>(utime + stime) / sysconf(_SC_CLK_TCK);
    }
    std::fclose(f);
  }
  if (FILE *f = std::fopen("/proc/self/status", "r")) {
    char line[256];
    while (std::fgets(line, sizeof(line), f)) {
      long v;
      if (std::sscanf(line, "VmRSS: %ld kB", &v) == 1) p.rss_mb = v / 1024.0;
      if (std::sscanf(line, "Threads: %ld", &v) == 1) p.threads = static_cast<int>(v);
    }
    std::fclose(f);
  }
  return p;
}

// ---- the server ---------------------------------------------------------------

class Server {
public:
  explicit Server(const Options &opt, const tf_affinity::PinPlan &plan)
      : opt_(opt), plan_(plan), start_ns_(now_ns()), win_start_ns_(start_ns_) {
    if (opt_.elastic_queue) ring_ = std::make_unique<ElasticRing<Job>>(opt_.ring_size);
    std::vector<Trade> ignored;
    WalRecord last;
    WalRecovery r = wal_recover(opt_.wal_path, [&](const WalRecord &rec) {
      ignored.clear();
      apply_record(ex_, rec, ignored);
      last = rec;
    });
    seq_ = r.last_seq;
    last_crc_ = r.records > 0 ? wal_frame_crc(last) : 0;
    wal_ = std::make_unique<WalWriter>(opt_.wal_path, opt_.wal_io);
    std::fprintf(stderr, "engine: recovered %llu records, last_seq %llu, dropped %llu bytes\n",
                 (unsigned long long)r.records, (unsigned long long)r.last_seq,
                 (unsigned long long)r.dropped_bytes);
  }

  int run() {
    int listen_fd = ::socket(AF_INET, SOCK_STREAM, 0);
    int yes = 1;
    ::setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<uint16_t>(opt_.port));
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (::bind(listen_fd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) != 0 ||
        ::listen(listen_fd, 64) != 0) {
      std::perror("engine: cannot listen");
      return 1;
    }

    std::thread matcher([this] {
#ifdef __linux__
      pthread_setname_np(pthread_self(), "tf-matcher");
#endif
      if (plan_.matcher_core >= 0) tf_affinity::set_current_thread({plan_.matcher_core});
      matcher_loop();
    });
    // Connection threads start from this thread, so they inherit this set.
    if (plan_.matcher_core >= 0) tf_affinity::set_current_thread(plan_.others);
    if (following()) std::thread([this] { follower_loop(); }).detach();
    std::fprintf(stderr, "engine: listening on 127.0.0.1:%d\n", opt_.port);

    while (!g_stop.load()) {
      pollfd pfd{listen_fd, POLLIN, 0};
      if (::poll(&pfd, 1, 200) <= 0) continue;
      int fd = ::accept(listen_fd, nullptr, nullptr);
      if (fd < 0) continue;
      add_connection(fd);
    }

    stopping_.store(true);
    wake_cv_.notify_all();
    matcher.join();
    ::close(listen_fd);
    // Connection threads are still running; the WAL already holds every ack.
    std::_Exit(0);
  }

private:
  // ---- connections ----

  void add_connection(int fd) {
    static const size_t MAX_CONNECTIONS = 100; // the queue supports 128 producer threads
    auto conn = std::make_shared<Conn>();
    {
      std::lock_guard<std::mutex> g(conns_mu_);
      if (conns_.size() >= MAX_CONNECTIONS) {
        ::close(fd);
        return;
      }
      int one = 1;
      ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
      conn->fd = fd;
      conn->id = ++next_conn_id_;
      produced_.emplace_back(0);
      conn->produced = &produced_.back();
      conns_[conn->id] = conn;
    }
    std::thread([this, conn] { serve(conn); }).detach();
  }

  // Send one line without ever blocking. A client that cannot keep up is dropped.
  static void send_line(Conn &c, const std::string &line) {
    std::lock_guard<std::mutex> g(c.write_mu);
    if (!c.open || c.replica) return;
    const char *p = line.data();
    size_t left = line.size();
    while (left > 0) {
      ssize_t n = ::send(c.fd, p, left, MSG_NOSIGNAL | MSG_DONTWAIT);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) {
        ::shutdown(c.fd, SHUT_RDWR); // makes the reader thread finish
        return;
      }
      p += n;
      left -= static_cast<size_t>(n);
    }
  }

  void reply_to(uint32_t conn_id, const std::string &line) {
    std::shared_ptr<Conn> c;
    {
      std::lock_guard<std::mutex> g(conns_mu_);
      auto it = conns_.find(conn_id);
      if (it == conns_.end()) return;
      c = it->second;
    }
    send_line(*c, line);
  }

  void broadcast(const std::string &line) {
    std::vector<std::shared_ptr<Conn>> all;
    {
      std::lock_guard<std::mutex> g(conns_mu_);
      for (auto &entry : conns_) all.push_back(entry.second);
    }
    for (auto &c : all) send_line(*c, line);
  }

  // Connection thread: read lines until the client goes away.
  void serve(std::shared_ptr<Conn> c) {
    std::string buf;
    char tmp[4096];
    while (!g_stop.load()) {
      ssize_t n = ::recv(c->fd, tmp, sizeof(tmp), 0);
      if (n <= 0) break;
      buf.append(tmp, static_cast<size_t>(n));
      size_t pos;
      while ((pos = buf.find('\n')) != std::string::npos) {
        std::string line = buf.substr(0, pos);
        buf.erase(0, pos + 1);
        handle_line(*c, line);
      }
      if (buf.size() > 4096) break; // no newline in 4 KB: not our protocol
    }
    {
      std::lock_guard<std::mutex> g(c->write_mu);
      c->open = false;
      ::close(c->fd);
    }
    std::lock_guard<std::mutex> g(conns_mu_);
    conns_.erase(c->id);
  }

  // ---- input handling (connection threads) ----

  void handle_line(Conn &c, const std::string &line) {
    JsonObject m;
    int64_t ref = 0;
    std::string type;
    if (!parse_json_object(line, m) || !get_string(m, "type", type)) {
      send_line(c, reject_json(0, "bad_request"));
      return;
    }
    get_int(m, "client_ref", ref);

    if (type == "new_order") on_new_order(c, m, ref);
    else if (type == "cancel") on_cancel(c, m, ref);
    else if (type == "command") on_command(c, m, ref);
    else if (type == "replicate" && opt_.replicate) serve_replica(c, m, ref);
    else send_line(c, reject_json(ref, "bad_request"));
  }

  void on_new_order(Conn &c, const JsonObject &m, int64_t ref) {
    if (following()) {
      send_line(c, reject_json(ref, "read_only"));
      return;
    }
    int64_t symbol, price, qty;
    std::string side;
    if (!get_int(m, "symbol_id", symbol) || !get_int(m, "price", price) ||
        !get_int(m, "qty", qty) || !get_string(m, "side", side) ||
        (side != "BUY" && side != "SELL") || price <= 0 || qty <= 0) {
      send_line(c, reject_json(ref, "bad_request"));
      return;
    }
    if (symbol < 1 || symbol > static_cast<int64_t>(MAX_SYMBOL_ID)) {
      send_line(c, reject_json(ref, "unknown_symbol"));
      return;
    }
    if (qty > opt_.max_qty) {
      send_line(c, reject_json(ref, "max_qty"));
      return;
    }
    // The band uses the last trade price. It is read here, outside the matching
    // thread, so it may be a moment old; replay does not repeat this check.
    int64_t last = ex_.last_price(static_cast<uint32_t>(symbol));
    if (last > 0 && std::llabs(price - last) * 100 > last * opt_.band_pct) {
      send_line(c, reject_json(ref, "price_band"));
      return;
    }

    // seq number, WAL write, ack and queue push happen together, so the
    // queue order is always the seq order.
    std::lock_guard<std::mutex> g(ingress_mu_);
    Job job;
    job.kind = Job::NewOrder;
    job.conn_id = c.id;
    job.client_ref = ref;
    job.order.seq = ++seq_;
    job.order.order_id = job.order.seq;
    job.order.ts_ms = now_ms();
    job.order.symbol_id = static_cast<uint32_t>(symbol);
    job.order.side = side == "BUY" ? Side::Buy : Side::Sell;
    job.order.price = price;
    job.order.qty = static_cast<uint32_t>(qty);

    WalRecord rec;
    rec.type = WalRecord::NewOrder;
    rec.seq = job.order.seq;
    rec.ts_ms = job.order.ts_ms;
    rec.order_id = job.order.order_id;
    rec.symbol_id = job.order.symbol_id;
    rec.side = static_cast<uint8_t>(job.order.side);
    rec.price = price;
    rec.qty = job.order.qty;
    write_wal(rec);

    send_line(c, ack_json(ref, job.order.order_id, job.order.seq));
    c.produced->fetch_add(1, std::memory_order_relaxed);
    push(job);
  }

  void on_cancel(Conn &c, const JsonObject &m, int64_t ref) {
    if (following()) {
      send_line(c, reject_json(ref, "read_only"));
      return;
    }
    int64_t order_id;
    if (!get_int(m, "order_id", order_id)) {
      send_line(c, reject_json(ref, "bad_request"));
      return;
    }
    std::lock_guard<std::mutex> g(ingress_mu_);
    if (order_id < 1 || static_cast<uint64_t>(order_id) > seq_) { // never issued
      send_line(c, reject_json(ref, "unknown_order"));
      return;
    }
    Job job;
    job.kind = Job::Cancel;
    job.conn_id = c.id;
    job.client_ref = ref;
    job.order.seq = ++seq_;
    job.cancel_id = static_cast<uint64_t>(order_id);

    WalRecord rec;
    rec.type = WalRecord::Cancel;
    rec.seq = job.order.seq;
    rec.ts_ms = now_ms();
    rec.order_id = job.cancel_id;
    write_wal(rec);

    // The matching thread sends the ack (or "unknown_order" if the order was
    // already filled), because only it knows what is on the book.
    c.produced->fetch_add(1, std::memory_order_relaxed);
    push(job);
  }

  void on_command(Conn &c, const JsonObject &m, int64_t ref) {
    std::string name;
    Job job;
    job.conn_id = c.id;
    job.client_ref = ref;
    if (!get_string(m, "name", name)) {
      send_line(c, reject_json(ref, "bad_request"));
      return;
    }
    if (name == "stats") {
      job.kind = Job::StatsCmd;
    } else if (name == "state_hash") {
      job.kind = Job::HashCmd;
    } else if (name == "book") {
      int64_t symbol, depth = 10;
      if (!get_int(m, "symbol_id", symbol)) {
        send_line(c, reject_json(ref, "bad_request"));
        return;
      }
      if (symbol < 1 || symbol > static_cast<int64_t>(MAX_SYMBOL_ID)) {
        send_line(c, reject_json(ref, "unknown_symbol"));
        return;
      }
      get_int(m, "depth", depth);
      job.kind = Job::BookCmd;
      job.order.symbol_id = static_cast<uint32_t>(symbol);
      job.depth = static_cast<uint32_t>(std::max<int64_t>(1, std::min<int64_t>(depth, 100)));
    } else {
      send_line(c, reject_json(ref, "bad_request"));
      return;
    }
    push(job);
  }

  // Not allowed to fail silently: an order must never be acked without being logged.
  void write_wal(const WalRecord &rec) {
    try {
      wal_->append(rec);
    } catch (const std::exception &e) {
      std::fprintf(stderr, "engine: fatal: %s\n", e.what());
      std::_Exit(1);
    }
    if (opt_.replicate) {
      {
        std::lock_guard<std::mutex> g(wal_mu_);
        wal_appends_.fetch_add(1, std::memory_order_relaxed);
      }
      wal_cv_.notify_all();
    }
  }

  void push(Job &job) {
    job.pushed_ns = now_ns();
    if (job.kind == Job::NewOrder || job.kind == Job::Cancel)
      submitted_.fetch_add(1, std::memory_order_relaxed);
    if (ring_) ring_->enqueue(job);
    else queue_.enqueue(job);
    if (sleeping_.load()) {
      std::lock_guard<std::mutex> g(wake_mu_); // pairs with the matcher's wait
      wake_cv_.notify_one();
    }
  }

  // ---- replication: leader side ----

  // Runs on the connection's own thread until the follower goes away.
  void serve_replica(Conn &c, const JsonObject &m, int64_t ref) {
    int64_t after_seq, after_crc;
    if (!get_int(m, "after_seq", after_seq) || !get_int(m, "after_crc", after_crc) || after_seq < 0) {
      send_line(c, reject_json(ref, "bad_request"));
      return;
    }
    uint64_t last;
    {
      std::lock_guard<std::mutex> g(ingress_mu_);
      last = seq_;
    }
    // Everything up to `last` is complete in the file, because it was written under the lock.
    if (static_cast<uint64_t>(after_seq) > last) {
      send_line(c, reject_json(ref, "follower_ahead"));
      return;
    }
    int fd = ::open(opt_.wal_path.c_str(), O_RDONLY);
    if (fd < 0) {
      send_line(c, reject_json(ref, "bad_request"));
      return;
    }
    uint64_t pos = WAL_HEADER_SIZE;
    if (!find_after(fd, static_cast<uint64_t>(after_seq), static_cast<uint32_t>(after_crc), pos)) {
      ::close(fd);
      send_line(c, reject_json(ref, "diverged"));
      return;
    }
    {
      // From here on this connection gets no more JSON lines, so the stream stays clean.
      std::lock_guard<std::mutex> g(c.write_mu);
      c.replica = true;
      if (!send_all(c.fd, "{\"type\":\"replicate_ok\",\"last_seq\":" + std::to_string(last) + "}\n")) {
        ::close(fd);
        return;
      }
    }
    replicas_.fetch_add(1);
    std::fprintf(stderr, "engine: follower connected, sending frames after seq %lld\n", (long long)after_seq);
    ship_frames(c, fd, pos);
    replicas_.fetch_sub(1);
    ::close(fd);
    ::shutdown(c.fd, SHUT_RDWR); // ends the connection's read loop
  }

  // Move `pos` past the frame with seq `after_seq`, which must have CRC `after_crc`.
  // This catches a follower of some other leader, and a leader that lost its tail. It
  // compares only that one frame, not everything before it.
  static bool find_after(int fd, uint64_t after_seq, uint32_t after_crc, uint64_t &pos) {
    if (after_seq == 0) return true;
    std::vector<char> buf(1 << 20);
    for (;;) {
      ssize_t n = ::pread(fd, buf.data(), buf.size(), static_cast<off_t>(pos));
      if (n <= 0) return false;
      size_t used = 0;
      for (;;) {
        WalRecord rec;
        size_t len = 0;
        WalFrame st = wal_decode_frame(buf.data() + used, static_cast<size_t>(n) - used, rec, len);
        if (st == WalFrame::Corrupt) return false;
        if (st == WalFrame::Incomplete) break;
        used += len;
        if (rec.seq == after_seq) {
          pos += used;
          return wal_frame_crc(rec) == after_crc;
        }
      }
      if (used == 0) return false;
      pos += used;
    }
  }

  void ship_frames(Conn &c, int fd, uint64_t pos) {
    std::vector<char> buf(1 << 20);
    while (!g_stop.load()) {
      const uint64_t seen = wal_appends_.load(std::memory_order_relaxed);
      ssize_t n = ::pread(fd, buf.data(), buf.size(), static_cast<off_t>(pos));
      if (n < 0) return;
      // Only whole frames: a frame being written right now is sent next time round.
      size_t ready = 0;
      while (ready < static_cast<size_t>(n)) {
        WalRecord rec;
        size_t len = 0;
        WalFrame st = wal_decode_frame(buf.data() + ready, static_cast<size_t>(n) - ready, rec, len);
        if (st == WalFrame::Incomplete) break;
        if (st == WalFrame::Corrupt) {
          std::fprintf(stderr, "engine: corrupt WAL frame at offset %llu, stopping replication\n",
                       (unsigned long long)(pos + ready));
          return;
        }
        ready += len;
      }
      if (ready > 0) {
        if (!send_all(c.fd, std::string(buf.data(), ready))) return;
        pos += ready;
        continue;
      }
      // Nothing new. Notice a follower that left, then wait for the next append.
      char probe;
      ssize_t got = ::recv(c.fd, &probe, 1, MSG_PEEK | MSG_DONTWAIT);
      if (got == 0 || (got < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) return;
      std::unique_lock<std::mutex> lk(wal_mu_);
      wal_cv_.wait_for(lk, std::chrono::milliseconds(20),
                       [&] { return wal_appends_.load(std::memory_order_relaxed) != seen; });
    }
  }

  // Blocking send of the whole string, for the WAL stream. False if the peer is gone.
  static bool send_all(int fd, const std::string &data) {
    const char *p = data.data();
    size_t left = data.size();
    while (left > 0) {
      ssize_t n = ::send(fd, p, left, MSG_NOSIGNAL);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) return false;
      p += n;
      left -= static_cast<size_t>(n);
    }
    return true;
  }

  // ---- replication: follower side ----

  bool following() const { return opt_.follow_port != 0; }

  void follower_loop() {
    while (!g_stop.load()) {
      int fd = ::socket(AF_INET, SOCK_STREAM, 0);
      sockaddr_in addr{};
      addr.sin_family = AF_INET;
      addr.sin_port = htons(static_cast<uint16_t>(opt_.follow_port));
      ::inet_pton(AF_INET, opt_.follow_host.c_str(), &addr.sin_addr);
      if (::connect(fd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) == 0) {
        leader_connected_.store(true);
        follow_stream(fd);
        leader_connected_.store(false);
      }
      ::close(fd);
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
  }

  // A problem that retrying cannot fix: stop, so that a supervisor or a person notices.
  [[noreturn]] static void follower_fatal(const std::string &why) {
    std::fprintf(stderr, "engine: follower stopping: %s\n", why.c_str());
    std::_Exit(3);
  }

  // Returns when the leader goes away or sends something damaged; the caller reconnects.
  void follow_stream(int fd) {
    uint64_t after_seq;
    uint32_t after_crc;
    {
      std::lock_guard<std::mutex> g(ingress_mu_);
      after_seq = seq_;
      after_crc = last_crc_;
    }
    if (!send_all(fd, "{\"type\":\"replicate\",\"client_ref\":0,\"after_seq\":" + std::to_string(after_seq) +
                          ",\"after_crc\":" + std::to_string(after_crc) + "}\n"))
      return;

    std::string buf;
    std::vector<char> tmp(1 << 16);
    bool streaming = false;
    while (!g_stop.load()) {
      ssize_t n = ::recv(fd, tmp.data(), tmp.size(), 0);
      if (n <= 0) return;
      buf.append(tmp.data(), static_cast<size_t>(n));

      // Before the stream starts the leader may still send trade lines; skip them.
      size_t pos;
      while (!streaming && (pos = buf.find('\n')) != std::string::npos) {
        std::string line = buf.substr(0, pos);
        buf.erase(0, pos + 1);
        if (line.find("\"type\":\"replicate_ok\"") != std::string::npos) streaming = true;
        else if (line.find("\"type\":\"reject\"") != std::string::npos)
          follower_fatal("the leader refused: " + line);
      }
      if (!streaming) continue;

      size_t used = 0;
      for (;;) {
        WalRecord rec;
        size_t len = 0;
        WalFrame st = wal_decode_frame(buf.data() + used, buf.size() - used, rec, len);
        if (st == WalFrame::Incomplete) break;
        if (st == WalFrame::Corrupt) {
          std::fprintf(stderr, "engine: damaged frame from the leader, reconnecting\n");
          damaged_frames_.fetch_add(1);
          return;
        }
        apply_replicated(rec);
        used += len;
      }
      buf.erase(0, used);
    }
  }

  // Same order as for a client's order: log first, then queue for the matcher.
  void apply_replicated(const WalRecord &rec) {
    std::lock_guard<std::mutex> g(ingress_mu_);
    if (rec.seq != seq_ + 1)
      follower_fatal("expected seq " + std::to_string(seq_ + 1) + " from the leader, got " + std::to_string(rec.seq));
    seq_ = rec.seq;
    last_crc_ = wal_frame_crc(rec);
    write_wal(rec);

    Job job;
    job.conn_id = 0; // no connection has this id, so nobody is sent an ack
    if (rec.type == WalRecord::NewOrder) {
      job.kind = Job::NewOrder;
      job.order = to_order(rec);
    } else {
      job.kind = Job::Cancel;
      job.order.seq = rec.seq;
      job.cancel_id = rec.order_id;
    }
    push(job);
  }

  // ---- matching thread ----

  bool next_job(Job &job) { return ring_ ? ring_->dequeue(job) : queue_.dequeue(job); }

  void matcher_loop() {
    Job job;
    for (;;) {
      if (next_job(job)) {
        process(job);
        continue;
      }
      if (stopping_.load()) break;
      // Queue is empty: sleep until a producer wakes us (or 10 ms pass).
      std::unique_lock<std::mutex> lk(wake_mu_);
      sleeping_.store(true);
      if (next_job(job)) { // something arrived just before we went to sleep
        sleeping_.store(false);
        lk.unlock();
        process(job);
        continue;
      }
      wake_cv_.wait_for(lk, std::chrono::milliseconds(10));
      sleeping_.store(false);
    }
  }

  void process(const Job &job) {
    switch (job.kind) {
    case Job::NewOrder: {
      trades_.clear();
      ex_.new_order(job.order, trades_);
      finish(job);
      for (const Trade &t : trades_) broadcast(trade_json(t));
      break;
    }
    case Job::Cancel: {
      bool found = ex_.cancel(job.order.seq, job.cancel_id);
      finish(job);
      reply_to(job.conn_id, found ? ack_json(job.client_ref, job.cancel_id, job.order.seq)
                                  : reject_json(job.client_ref, "unknown_order"));
      break;
    }
    case Job::BookCmd:
      reply_to(job.conn_id, book_json(job.order.symbol_id, job.depth));
      break;
    case Job::HashCmd:
      reply_to(job.conn_id, "{\"type\":\"state_hash\",\"hash\":\"" + hash_hex(ex_.state_hash()) +
                                "\",\"last_seq\":" + std::to_string(ex_.last_seq()) + "}\n");
      break;
    case Job::StatsCmd:
      reply_to(job.conn_id, stats_json());
      break;
    }
  }

  // Record how long the job took, from push to "matching finished".
  void finish(const Job &job) {
    int64_t ns = now_ns() - job.pushed_ns;
    processed_++;
    lat_sum_ns_ += ns;
    lat_ring_[lat_count_ % LAT_RING] = static_cast<uint32_t>(std::min<int64_t>(ns, UINT32_MAX));
    lat_count_++;
    int64_t us = ns / 1000;
    int bucket = us == 0 ? 0 : std::min(64 - __builtin_clzll(static_cast<unsigned long long>(us)), 15);
    lat_hist_[bucket]++;
  }

  std::string book_json(uint32_t symbol, uint32_t depth) {
    MapBook::Levels bids, asks;
    if (const MapBook *b = ex_.book(symbol)) {
      b->levels(Side::Buy, depth, bids);
      b->levels(Side::Sell, depth, asks);
    }
    return "{\"type\":\"book\",\"symbol_id\":" + std::to_string(symbol) +
           ",\"bids\":" + levels_json(bids) + ",\"asks\":" + levels_json(asks) + "}\n";
  }

  std::string stats_json() {
    double now_s = (now_ns() - start_ns_) / 1e9;
    ProcInfo proc = read_proc();
    uint64_t trades_total = ex_.trades_total();

    // Rates are measured over windows of at least one second.
    double win_s = (now_ns() - win_start_ns_) / 1e9;
    if (win_s >= 1.0 || !have_rates_) {
      win_s = std::max(win_s, 0.001);
      orders_per_sec_ = (processed_ - win_processed_) / win_s;
      trades_per_sec_ = (trades_total - win_trades_) / win_s;
      cpu_pct_ = (proc.cpu_seconds - win_cpu_) / win_s * 100.0;
      win_start_ns_ = now_ns();
      win_processed_ = processed_;
      win_trades_ = trades_total;
      win_cpu_ = proc.cpu_seconds;
      have_rates_ = true;
    }

    // Percentiles from the most recent samples.
    double p50 = 0, p99 = 0;
    size_t n = static_cast<size_t>(std::min<uint64_t>(lat_count_, LAT_RING));
    if (n > 0) {
      std::vector<uint32_t> v(lat_ring_.begin(), lat_ring_.begin() + n);
      size_t i50 = n / 2, i99 = std::min(n - 1, n * 99 / 100);
      std::nth_element(v.begin(), v.begin() + i50, v.end());
      p50 = v[i50] / 1000.0;
      std::nth_element(v.begin(), v.begin() + i99, v.end());
      p99 = v[i99] / 1000.0;
    }
    double avg = processed_ ? lat_sum_ns_ / 1000.0 / static_cast<double>(processed_) : 0;

    uint64_t submitted = submitted_.load();
    std::string hist = "[";
    for (int i = 0; i < 16; i++) hist += (i ? "," : "") + std::to_string(lat_hist_[i]);
    hist += "]";
    std::string producers = "[";
    {
      std::lock_guard<std::mutex> g(conns_mu_);
      for (size_t i = 0; i < produced_.size(); i++)
        producers += (i ? "," : "") + std::to_string(produced_[i].load());
    }
    producers += "]";

    char head[512];
    std::snprintf(head, sizeof(head),
                  "{\"type\":\"stats\",\"uptime_s\":%.1f,\"submitted\":%llu,\"processed\":%llu,"
                  "\"queue_depth\":%llu,\"orders_per_sec\":%.1f,\"trades_total\":%llu,"
                  "\"trades_per_sec\":%.1f,\"avg_latency_us\":%.1f,\"p50_latency_us\":%.1f,"
                  "\"p99_latency_us\":%.1f,",
                  now_s, (unsigned long long)submitted, (unsigned long long)processed_,
                  (unsigned long long)(submitted > processed_ ? submitted - processed_ : 0),
                  orders_per_sec_, (unsigned long long)trades_total, trades_per_sec_, avg, p50, p99);
    char tail[256];
    std::snprintf(tail, sizeof(tail),
                  ",\"threads\":%d,\"cpu_pct\":%.1f,\"rss_mb\":%.1f,\"last_seq\":%llu,"
                  "\"state_hash\":\"%s\"}\n",
                  proc.threads, cpu_pct_, proc.rss_mb, (unsigned long long)ex_.last_seq(),
                  hash_hex(ex_.state_hash()).c_str());
    // Only with --queue elastic, so the default reply is unchanged.
    std::string ring_stats;
    if (ring_)
      ring_stats = ",\"ring_capacity\":" + std::to_string(ring_->capacity()) +
                   ",\"ring_overflowed\":" + std::to_string(ring_->overflowed_total());
    // Only with replication turned on, so the default reply is unchanged.
    if (opt_.replicate) ring_stats += ",\"role\":\"leader\",\"replicas\":" + std::to_string(replicas_.load());
    if (following())
      ring_stats += std::string(",\"role\":\"follower\",\"leader_connected\":") +
                    (leader_connected_.load() ? "true" : "false") +
                    ",\"damaged_frames\":" + std::to_string(damaged_frames_.load());
    return std::string(head) + "\"lat_hist\":" + hist + ",\"producers\":" + producers + ring_stats + tail;
  }

  // ---- data ----

  Options opt_;
  tf_affinity::PinPlan plan_;
  Exchange<MapBook> ex_;            // touched by the matching thread only (and recovery)
  std::unique_ptr<WalWriter> wal_;  // guarded by ingress_mu_
  uint64_t seq_ = 0;                // guarded by ingress_mu_
  uint32_t last_crc_ = 0;           // follower only: of the frame with seq_, for the handshake
  std::mutex ingress_mu_;

  // Replication.
  static constexpr uint64_t WAL_HEADER_SIZE = 8;
  std::mutex wal_mu_;
  std::condition_variable wal_cv_;
  std::atomic<uint64_t> wal_appends_{0};
  std::atomic<int> replicas_{0};
  std::atomic<bool> leader_connected_{false};
  std::atomic<uint64_t> damaged_frames_{0}; // a follower recovers from these by reconnecting

  MPSCQueue<Job> queue_;
  std::unique_ptr<ElasticRing<Job>> ring_; // used instead of queue_ with --queue elastic
  std::mutex wake_mu_;
  std::condition_variable wake_cv_;
  std::atomic<bool> sleeping_{false};
  std::atomic<bool> stopping_{false};

  std::mutex conns_mu_;
  std::map<uint32_t, std::shared_ptr<Conn>> conns_;
  std::deque<std::atomic<uint64_t>> produced_; // one counter per connection ever seen
  uint32_t next_conn_id_ = 0;

  // Statistics (matching thread only, except submitted_).
  static constexpr size_t LAT_RING = 65536;
  std::atomic<uint64_t> submitted_{0};
  uint64_t processed_ = 0;
  int64_t lat_sum_ns_ = 0;
  uint64_t lat_count_ = 0;
  std::vector<uint32_t> lat_ring_ = std::vector<uint32_t>(LAT_RING);
  uint64_t lat_hist_[16] = {0};
  std::vector<Trade> trades_; // scratch space for one order's trades
  int64_t start_ns_;
  int64_t win_start_ns_;
  uint64_t win_processed_ = 0, win_trades_ = 0;
  double win_cpu_ = 0, orders_per_sec_ = 0, trades_per_sec_ = 0, cpu_pct_ = 0;
  bool have_rates_ = false;
};

static bool parse_args(int argc, char **argv, Options &opt) {
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--pin" || a == "--no-pin") {
      opt.pin = a == "--pin";
      continue;
    }
    if (a == "--replicate") {
      opt.replicate = true;
      continue;
    }
    if (i + 1 >= argc) return false;
    std::string v = argv[++i];
    if (a == "--port") opt.port = std::atoi(v.c_str());
    else if (a == "--wal") opt.wal_path = v;
    else if (a == "--max-qty") opt.max_qty = std::atoll(v.c_str());
    else if (a == "--band-pct") opt.band_pct = std::atoll(v.c_str());
    else if (a == "--queue") {
      if (v != "lockfree" && v != "elastic") return false;
      opt.elastic_queue = v == "elastic";
    } else if (a == "--wal-io") {
      if (v != "write" && v != "uring") return false;
      opt.wal_io = v == "uring" ? WalIo::Uring : WalIo::Write;
    } else if (a == "--ring-size") {
      long long n = std::atoll(v.c_str());
      if (n < 2 || n > (1LL << 30)) return false;
      opt.ring_size = static_cast<size_t>(n);
    } else if (a == "--pin-core") {
      opt.pin = true;
      opt.pin_core = std::atoi(v.c_str());
    } else if (a == "--follow") {
      size_t colon = v.rfind(':');
      if (colon == std::string::npos) return false;
      opt.follow_host = v.substr(0, colon);
      opt.follow_port = std::atoi(v.c_str() + colon + 1);
      in_addr check{};
      if (opt.follow_port <= 0 || opt.follow_port > 65535 ||
          ::inet_pton(AF_INET, opt.follow_host.c_str(), &check) != 1)
        return false;
    }
    else return false;
  }
  if (opt.follow_port != 0 && opt.replicate) return false; // no chains: not tested
  return !opt.wal_path.empty() && opt.port > 0 && opt.port < 65536 && opt.max_qty > 0 &&
         opt.band_pct > 0;
}

int main(int argc, char **argv) {
  Options opt;
  if (!parse_args(argc, argv, opt)) {
    std::fprintf(stderr,
                 "usage: engine_server --wal <file> [--port 9100] [--max-qty 10000] "
                 "[--band-pct 20] [--pin | --no-pin] [--pin-core N] "
                 "[--queue lockfree|elastic] [--ring-size 65536] [--wal-io write|uring] "
                 "[--replicate | --follow HOST:PORT]\n");
    return 2;
  }
  std::signal(SIGINT, on_signal);
  std::signal(SIGTERM, on_signal);
  std::signal(SIGPIPE, SIG_IGN);
  try {
    if (opt.wal_io == WalIo::Uring) {
      std::string why;
      if (!UringWriter::supported(&why)) { // asked for by name, so do not quietly use something else
        std::fprintf(stderr, "engine: --wal-io uring is not available here: %s\n", why.c_str());
        return 2;
      }
    }
    tf_affinity::PinPlan plan;
    if (opt.pin) {
      plan = tf_affinity::make_plan(tf_affinity::allowed_cpus(), opt.pin_core, tf_affinity::smt_siblings);
      std::fprintf(stderr, "engine: pinning: %s\n", plan.note.c_str());
      // An explicit core that cannot be used is a mistake; the automatic choice
      // just runs unpinned on a machine with too few CPUs.
      if (opt.pin_core >= 0 && plan.matcher_core < 0) return 2;
    }
    Server server(opt, plan);
    return server.run();
  } catch (const std::exception &e) {
    std::fprintf(stderr, "engine: %s\n", e.what());
    return 1;
  }
}
