#pragma once
// Record layer: what a WAL record looks like and how it is (de)serialized.
// Knows nothing about files or recovery.
#include "order.hpp"
#include <cstdint>
#include <optional>
#include <string>
#include <variant>

namespace wal {

struct SetRecord {
  std::string key;
  std::string value;
};

// A decoded payload record. Trade is the matching engine's own struct.
using Payload = std::variant<SetRecord, Trade>;

// Line format (one record per line, '|' separated):
//   SET|<key>|<value>
//   TRADE|<trade_id>|<symbol_id>|<price>|<qty>|<buy_order_id>|<sell_order_id>
std::string encode(const SetRecord &r);
std::string encode(const Trade &t);

// Returns nullopt for malformed / unknown records.
std::optional<Payload> decode(const std::string &line);

// Transaction framing lines.
std::string begin_line(uint64_t txid);
std::string commit_line(uint64_t txid);

// Strict unsigned parse: digits only, whole string consumed.
bool parse_u64(const std::string &s, uint64_t &out);

// Keys must be non-empty and free of '|' and line breaks; values free of line
// breaks (a '|' inside a value is fine, it is the last field).
bool valid_key(const std::string &key);
bool valid_value(const std::string &value);

} // namespace wal
