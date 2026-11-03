#pragma once
// Rebuild an Exchange from a WAL file.
#include "exchange.hpp"
#include "wal.hpp"

// Turn a logged input into an Order. (Cancels use only order_id and seq.)
inline Order to_order(const WalRecord &r) {
  Order o;
  o.order_id = r.order_id;
  o.seq = r.seq;
  o.ts_ms = r.ts_ms;
  o.symbol_id = r.symbol_id;
  o.side = r.side == 0 ? Side::Buy : Side::Sell;
  o.price = r.price;
  o.qty = r.qty;
  return o;
}

// Feed one logged input to the exchange. Trades are appended to `trades`.
template <class Book>
void apply_record(Exchange<Book> &ex, const WalRecord &r, std::vector<Trade> &trades) {
  if (r.type == WalRecord::NewOrder) ex.new_order(to_order(r), trades);
  else ex.cancel(r.seq, r.order_id);
}

// Replay the whole file into `ex` (trades are discarded: clients are not told
// about old trades). Also truncates a half-written last frame.
template <class Book> WalRecovery recover_exchange(const std::string &path, Exchange<Book> &ex) {
  std::vector<Trade> ignored;
  return wal_recover(path, [&](const WalRecord &r) {
    ignored.clear();
    apply_record(ex, r, ignored);
  });
}
