#include "order_book.hpp"
#include <algorithm>

void OrderBook::insert_resting(const Order &order) {
  if (order.side == Side::BUY) {
    buy_levels_[order.price].push_back(order);
  } else {
    sell_levels_[order.price].push_back(order);
  }
}

std::vector<Trade> OrderBook::match(Order incoming, uint64_t &trade_counter) {
  std::vector<Trade> trades;

  if (incoming.side == Side::BUY) {
    while (incoming.quantity > 0 && !sell_levels_.empty()) {
      auto best = sell_levels_.begin();
      if (best->first > incoming.price) {
        break;
      }

      auto &level_orders = best->second;
      while (incoming.quantity > 0 && !level_orders.empty()) {
        Order &resting = level_orders.front();
        uint32_t filled = std::min(incoming.quantity, resting.quantity);

        Trade t;
        t.trade_id = trade_counter++;
        t.symbol_id = incoming.symbol_id;
        t.price = best->first;
        t.quantity = filled;
        t.buy_order_id = incoming.order_id;
        t.sell_order_id = resting.order_id;
        trades.push_back(t);

        incoming.quantity -= filled;
        resting.quantity -= filled;

        if (resting.quantity == 0) {
          level_orders.pop_front();
        }
      }

      if (level_orders.empty()) {
        sell_levels_.erase(best);
      }
    }

    if (incoming.quantity > 0) {
      insert_resting(incoming);
    }
  } else {
    while (incoming.quantity > 0 && !buy_levels_.empty()) {
      auto best = buy_levels_.begin();
      if (best->first < incoming.price) {
        break;
      }

      auto &level_orders = best->second;
      while (incoming.quantity > 0 && !level_orders.empty()) {
        Order &resting = level_orders.front();
        uint32_t filled = std::min(incoming.quantity, resting.quantity);

        Trade t;
        t.trade_id = trade_counter++;
        t.symbol_id = incoming.symbol_id;
        t.price = best->first;
        t.quantity = filled;
        t.buy_order_id = resting.order_id;
        t.sell_order_id = incoming.order_id;
        trades.push_back(t);

        incoming.quantity -= filled;
        resting.quantity -= filled;

        if (resting.quantity == 0) {
          level_orders.pop_front();
        }
      }

      if (level_orders.empty()) {
        buy_levels_.erase(best);
      }
    }

    if (incoming.quantity > 0) {
      insert_resting(incoming);
    }
  }

  return trades;
}
