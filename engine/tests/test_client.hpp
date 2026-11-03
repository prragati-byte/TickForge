#pragma once
// A tiny line-based TCP client for the tests that drive a real engine_server.
#include "json_lite.hpp"
#include "test_util.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <string>
#include <sys/socket.h>
#include <unistd.h>

struct Client {
  int fd = -1;
  std::string buf;

  bool connect_to(int port) {
    for (int attempt = 0; attempt < 100; attempt++) { // wait up to ~5 s for the server
      fd = ::socket(AF_INET, SOCK_STREAM, 0);
      sockaddr_in a{};
      a.sin_family = AF_INET;
      a.sin_port = htons(static_cast<uint16_t>(port));
      a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
      if (::connect(fd, reinterpret_cast<sockaddr *>(&a), sizeof(a)) == 0) return true;
      ::close(fd);
      usleep(50 * 1000);
    }
    return false;
  }

  void send(const std::string &line) {
    std::string s = line + "\n";
    CHECK(::write(fd, s.data(), s.size()) == static_cast<ssize_t>(s.size()));
  }

  // Next line, or "" after 3 seconds.
  std::string read_line() {
    for (;;) {
      size_t pos = buf.find('\n');
      if (pos != std::string::npos) {
        std::string line = buf.substr(0, pos);
        buf.erase(0, pos + 1);
        return line;
      }
      pollfd p{fd, POLLIN, 0};
      if (::poll(&p, 1, 3000) <= 0) return "";
      char tmp[4096];
      ssize_t n = ::read(fd, tmp, sizeof(tmp));
      if (n <= 0) return "";
      buf.append(tmp, static_cast<size_t>(n));
    }
  }

  // Read lines until one has "type" == type; other lines (e.g. trades) are skipped.
  // Returns the raw line ("" on timeout).
  std::string read_type(const std::string &type) {
    for (;;) {
      std::string line = read_line();
      if (line.empty()) {
        CHECK(!"timed out waiting for a reply");
        return line;
      }
      if (line.find("\"type\":\"" + type + "\"") != std::string::npos) return line;
    }
  }

  // Send a command and return the raw reply line.
  std::string ask(const std::string &cmd, const std::string &type) {
    send(cmd);
    return read_type(type);
  }

  // Send an order/cancel; returns the ack or reject (skipping trade lines).
  JsonObject request(const std::string &line, int64_t ref) {
    send(line);
    for (;;) {
      std::string reply = read_line();
      JsonObject m;
      if (reply.empty()) {
        CHECK(!"timed out waiting for ack/reject");
        return m;
      }
      std::string t;
      int64_t r = -1;
      if (parse_json_object(reply, m) && get_string(m, "type", t) &&
          (t == "ack" || t == "reject") && get_int(m, "client_ref", r) && r == ref)
        return m;
    }
  }
};

inline std::string order_json(int ref, int symbol, const char *side, int64_t price, int64_t qty) {
  return "{\"type\":\"new_order\",\"client_ref\":" + std::to_string(ref) +
         ",\"symbol_id\":" + std::to_string(symbol) + ",\"side\":\"" + side +
         "\",\"price\":" + std::to_string(price) + ",\"qty\":" + std::to_string(qty) + "}";
}

inline std::string reason_of(const JsonObject &m) {
  std::string t, r;
  get_string(m, "type", t);
  get_string(m, "reason", r);
  return t == "reject" ? r : "(" + t + ")";
}

inline std::string extract(const std::string &line, const std::string &key) {
  size_t k = line.find("\"" + key + "\":");
  if (k == std::string::npos) return "";
  size_t start = k + key.size() + 3;
  size_t end = line.find_first_of(",}", start);
  return line.substr(start, end - start);
}
