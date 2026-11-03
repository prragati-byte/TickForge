#include "wal/wal_record.hpp"
#include <cmath>
#include <cstdio>
#include <exception>
#include <limits>
#include <vector>

namespace wal {
namespace {

// Split on '|' into at most max_parts pieces; the last piece keeps any
// remaining '|' characters.
std::vector<std::string> split(const std::string &s, size_t max_parts) {
  std::vector<std::string> parts;
  size_t start = 0;
  while (parts.size() + 1 < max_parts) {
    size_t pos = s.find('|', start);
    if (pos == std::string::npos) {
      break;
    }
    parts.push_back(s.substr(start, pos - start));
    start = pos + 1;
  }
  parts.push_back(s.substr(start));
  return parts;
}

bool parse_price(const std::string &s, double &out) {
  if (s.empty()) {
    return false;
  }
  try {
    size_t used = 0;
    double v = std::stod(s, &used);
    if (used != s.size() || !std::isfinite(v)) {
      return false;
    }
    out = v;
    return true;
  } catch (const std::exception &) {
    return false;
  }
}

} // namespace

bool parse_u64(const std::string &s, uint64_t &out) {
  if (s.empty() || s[0] < '0' || s[0] > '9') {
    return false;
  }
  try {
    size_t used = 0;
    unsigned long long v = std::stoull(s, &used);
    if (used != s.size()) {
      return false;
    }
    out = v;
    return true;
  } catch (const std::exception &) {
    return false;
  }
}

bool valid_key(const std::string &key) {
  return !key.empty() && key.find_first_of("|\n\r") == std::string::npos;
}

bool valid_value(const std::string &value) {
  return value.find_first_of("\n\r") == std::string::npos;
}

std::string encode(const SetRecord &r) { return "SET|" + r.key + "|" + r.value; }

std::string encode(const Trade &t) {
  char price[40];
  // %.17g round-trips every double exactly.
  std::snprintf(price, sizeof(price), "%.17g", t.price);
  return "TRADE|" + std::to_string(t.trade_id) + "|" +
         std::to_string(t.symbol_id) + "|" + price + "|" +
         std::to_string(t.quantity) + "|" + std::to_string(t.buy_order_id) +
         "|" + std::to_string(t.sell_order_id);
}

std::optional<Payload> decode(const std::string &line) {
  if (line.compare(0, 4, "SET|") == 0) {
    auto p = split(line, 3);
    if (p.size() != 3 || !valid_key(p[1])) {
      return std::nullopt;
    }
    return Payload{SetRecord{p[1], p[2]}};
  }

  if (line.compare(0, 6, "TRADE|") == 0) {
    auto p = split(line, 7);
    if (p.size() != 7) {
      return std::nullopt;
    }
    Trade t{};
    uint64_t qty = 0;
    if (!parse_u64(p[1], t.trade_id) || !parse_u64(p[2], t.symbol_id) ||
        !parse_price(p[3], t.price) || !parse_u64(p[4], qty) ||
        qty > std::numeric_limits<uint32_t>::max() ||
        !parse_u64(p[5], t.buy_order_id) || !parse_u64(p[6], t.sell_order_id)) {
      return std::nullopt;
    }
    t.quantity = static_cast<uint32_t>(qty);
    return Payload{t};
  }

  return std::nullopt;
}

std::string begin_line(uint64_t txid) { return "BEGIN|" + std::to_string(txid); }
std::string commit_line(uint64_t txid) {
  return "COMMIT|" + std::to_string(txid);
}

} // namespace wal
