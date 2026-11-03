// Unit tests for the order books, the exchange state hash and the JSON reader.
// The same book tests run on MapBook and DenseBook.
#include "dense_book.hpp"
#include "exchange.hpp"
#include "json_lite.hpp"
#include "map_book.hpp"
#include "test_util.hpp"
#include "wal.hpp"

#include <cstring>
#include <random>

// Places orders into one book and keeps the trades it produces.
template <class Book> struct Harness {
  Book book;
  uint64_t seq = 0;
  uint64_t next_trade_id = 1;
  std::vector<Trade> trades;

  uint64_t add(Side side, int64_t price, uint32_t qty) {
    Order o;
    o.order_id = o.seq = ++seq;
    o.symbol_id = 1;
    o.side = side;
    o.price = price;
    o.qty = qty;
    trades.clear();
    book.add(o, next_trade_id, trades);
    return o.order_id;
  }
};

template <class Book> void test_book() {
  {
    // Orders that do not cross just rest.
    Harness<Book> h;
    h.add(Side::Buy, 10000, 100);
    h.add(Side::Sell, 10500, 10);
    CHECK(h.trades.empty());
    MapBook::Levels bids, asks;
    h.book.levels(Side::Buy, 10, bids);
    h.book.levels(Side::Sell, 10, asks);
    CHECK(bids.size() == 1 && bids[0].first == 10000 && bids[0].second == 100);
    CHECK(asks.size() == 1 && asks[0].first == 10500 && asks[0].second == 10);
  }
  {
    // Partial fill: the rest of the resting order stays; trade prints at its price.
    Harness<Book> h;
    h.add(Side::Buy, 10000, 100);
    h.add(Side::Sell, 9900, 60);
    CHECK(h.trades.size() == 1);
    CHECK(h.trades[0].price == 10000 && h.trades[0].qty == 60);
    CHECK(h.trades[0].buy_order_id == 1 && h.trades[0].sell_order_id == 2);
    CHECK(h.trades[0].taker_side == Side::Sell);
    MapBook::Levels bids;
    h.book.levels(Side::Buy, 10, bids);
    CHECK(bids.size() == 1 && bids[0].second == 40);
  }
  {
    // Price priority: the cheapest ask fills first.
    Harness<Book> h;
    h.add(Side::Sell, 10100, 10);
    h.add(Side::Sell, 10000, 10);
    h.add(Side::Buy, 10100, 10);
    CHECK(h.trades.size() == 1 && h.trades[0].price == 10000 && h.trades[0].sell_order_id == 2);
  }
  {
    // Time priority: the older order at the same price fills first.
    Harness<Book> h;
    h.add(Side::Buy, 10000, 100); // id 1
    h.add(Side::Buy, 10000, 100); // id 2
    h.add(Side::Sell, 10000, 150);
    CHECK(h.trades.size() == 2);
    CHECK(h.trades[0].buy_order_id == 1 && h.trades[0].qty == 100);
    CHECK(h.trades[1].buy_order_id == 2 && h.trades[1].qty == 50);
    MapBook::Levels bids;
    h.book.levels(Side::Buy, 10, bids);
    CHECK(bids.size() == 1 && bids[0].second == 50);
  }
  {
    // A big order sweeps several levels, then rests what is left.
    Harness<Book> h;
    h.add(Side::Sell, 10000, 10);
    h.add(Side::Sell, 10010, 10);
    h.add(Side::Sell, 10020, 10);
    h.add(Side::Buy, 10010, 50);
    CHECK(h.trades.size() == 2);
    CHECK(h.trades[0].price == 10000 && h.trades[1].price == 10010);
    CHECK(h.trades[0].trade_id == 1 && h.trades[1].trade_id == 2);
    MapBook::Levels bids, asks;
    h.book.levels(Side::Buy, 10, bids);
    h.book.levels(Side::Sell, 10, asks);
    CHECK(bids.size() == 1 && bids[0].first == 10010 && bids[0].second == 30);
    CHECK(asks.size() == 1 && asks[0].first == 10020);
  }
  {
    // Cancel removes a resting order; a second cancel or a filled order fails.
    Harness<Book> h;
    uint64_t a = h.add(Side::Buy, 10000, 100);
    uint64_t b = h.add(Side::Buy, 10000, 50);
    CHECK(h.book.cancel(a));
    CHECK(!h.book.cancel(a));
    h.add(Side::Sell, 10000, 50); // fills b completely
    CHECK(!h.book.cancel(b));
    MapBook::Levels bids;
    h.book.levels(Side::Buy, 10, bids);
    CHECK(bids.empty());
    h.add(Side::Sell, 10000, 5); // nothing left to match
    CHECK(h.trades.empty());
  }
  {
    // Levels are summed per price and sorted best first.
    Harness<Book> h;
    h.add(Side::Buy, 9990, 5);
    h.add(Side::Buy, 10000, 7);
    h.add(Side::Buy, 10000, 3);
    MapBook::Levels bids;
    h.book.levels(Side::Buy, 10, bids);
    CHECK(bids.size() == 2 && bids[0].first == 10000 && bids[0].second == 10);
    CHECK(bids[1].first == 9990);
    MapBook::Levels one;
    h.book.levels(Side::Buy, 1, one);
    CHECK(one.size() == 1);
  }
}

// Random inputs through both book types must give the same trades and state.
void test_books_agree() {
  Exchange<MapBook> a;
  Exchange<DenseBook> b;
  std::mt19937 rng(42);
  std::vector<Trade> ta, tb;
  uint64_t seq = 0;
  for (int i = 0; i < 30000; i++) {
    ta.clear();
    tb.clear();
    ++seq;
    if (seq > 10 && rng() % 100 < 15) {
      uint64_t victim = 1 + rng() % (seq - 1);
      CHECK(a.cancel(seq, victim) == b.cancel(seq, victim));
    } else {
      Order o;
      o.order_id = o.seq = seq;
      o.ts_ms = 1000 + seq;
      o.symbol_id = 1 + rng() % 3;
      o.side = rng() % 2 ? Side::Buy : Side::Sell;
      o.price = 9900 + rng() % 200;
      o.qty = 1 + rng() % 200;
      a.new_order(o, ta);
      b.new_order(o, tb);
    }
    bool same = ta.size() == tb.size();
    for (size_t k = 0; same && k < ta.size(); k++)
      same = ta[k].trade_id == tb[k].trade_id && ta[k].price == tb[k].price &&
             ta[k].qty == tb[k].qty && ta[k].buy_order_id == tb[k].buy_order_id &&
             ta[k].sell_order_id == tb[k].sell_order_id;
    CHECK(same);
    if (!same) return;
  }
  CHECK(a.state_hash() == b.state_hash());
  CHECK(a.trades_total() > 100); // the test really produced trades
}

void test_state_hash() {
  auto run = [](uint32_t last_qty) {
    Exchange<MapBook> ex;
    std::vector<Trade> t;
    for (uint64_t s = 1; s <= 5; s++) {
      Order o;
      o.order_id = o.seq = s;
      o.symbol_id = 1;
      o.side = Side::Buy;
      o.price = 10000 + s;
      o.qty = s == 5 ? last_qty : 10;
      ex.new_order(o, t);
    }
    return ex.state_hash();
  };
  CHECK(run(10) == run(10)); // same input, same hash
  CHECK(run(10) != run(11)); // different state, different hash
}

void test_crc_and_json() {
  const char *s = "123456789";
  CHECK(crc32(reinterpret_cast<const uint8_t *>(s), std::strlen(s)) == 0xCBF43926u);

  JsonObject o;
  CHECK(parse_json_object("{\"type\":\"new_order\",\"price\":18950,\"x\":-3}", o));
  int64_t v = 0;
  std::string str;
  CHECK(get_int(o, "price", v) && v == 18950);
  CHECK(get_int(o, "x", v) && v == -3);
  CHECK(get_string(o, "type", str) && str == "new_order");
  CHECK(!get_int(o, "type", v));
  CHECK(parse_json_object("{\"price\":189.5}", o));
  CHECK(!get_int(o, "price", v)); // floats are not whole numbers
  CHECK(!parse_json_object("{\"a\":1", o));
  CHECK(!parse_json_object("not json", o));
  CHECK(!parse_json_object("{\"a\":1} extra", o));
}

int main() {
  test_book<MapBook>();
  test_book<DenseBook>();
  test_books_agree();
  test_state_hash();
  test_crc_and_json();
  return finish("order_book_tests");
}
