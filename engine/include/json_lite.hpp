#pragma once
// Just enough JSON for the engine protocol: one flat object per line whose
// values are strings or numbers. get_int() only accepts whole numbers, so a
// price like 189.5 is refused by the caller.
#include <cstdint>
#include <map>
#include <string>

struct JsonValue {
  bool is_string = false;
  bool is_whole = true; // false for numbers like 1.5
  std::string str;
  int64_t num = 0;
};

using JsonObject = std::map<std::string, JsonValue>;

namespace json_lite_detail {

inline void skip_space(const std::string &s, size_t &i) {
  while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r')) i++;
}

// Reads a "quoted" string without escapes (the protocol never needs them).
inline bool read_string(const std::string &s, size_t &i, std::string &out) {
  if (i >= s.size() || s[i] != '"') return false;
  size_t end = s.find('"', i + 1);
  if (end == std::string::npos) return false;
  out = s.substr(i + 1, end - i - 1);
  if (out.find('\\') != std::string::npos) return false;
  i = end + 1;
  return true;
}

} // namespace json_lite_detail

// Returns false if the line is not a flat JSON object of strings and integers.
inline bool parse_json_object(const std::string &line, JsonObject &out) {
  using namespace json_lite_detail;
  out.clear();
  size_t i = 0;
  skip_space(line, i);
  if (i >= line.size() || line[i] != '{') return false;
  i++;
  skip_space(line, i);
  if (i < line.size() && line[i] == '}') return true;

  while (true) {
    skip_space(line, i);
    std::string key;
    if (!read_string(line, i, key)) return false;
    skip_space(line, i);
    if (i >= line.size() || line[i] != ':') return false;
    i++;
    skip_space(line, i);

    JsonValue v;
    if (i < line.size() && line[i] == '"') {
      v.is_string = true;
      if (!read_string(line, i, v.str)) return false;
    } else {
      size_t start = i;
      if (i < line.size() && line[i] == '-') i++;
      size_t digits = i;
      while (i < line.size() && line[i] >= '0' && line[i] <= '9') i++;
      if (i == digits || i - digits > 18) return false; // no digits, or too long
      v.num = std::stoll(line.substr(start, i - start));
      if (i < line.size() && line[i] == '.') { // a decimal: parsed, but not a whole number
        i++;
        while (i < line.size() && line[i] >= '0' && line[i] <= '9') i++;
        v.is_whole = false;
      }
    }
    out[key] = v;

    skip_space(line, i);
    if (i >= line.size()) return false;
    if (line[i] == ',') {
      i++;
      continue;
    }
    if (line[i] == '}') {
      i++;
      skip_space(line, i);
      return i == line.size();
    }
    return false;
  }
}

inline bool get_int(const JsonObject &o, const char *key, int64_t &out) {
  auto it = o.find(key);
  if (it == o.end() || it->second.is_string || !it->second.is_whole) return false;
  out = it->second.num;
  return true;
}

inline bool get_string(const JsonObject &o, const char *key, std::string &out) {
  auto it = o.find(key);
  if (it == o.end() || !it->second.is_string) return false;
  out = it->second.str;
  return true;
}
