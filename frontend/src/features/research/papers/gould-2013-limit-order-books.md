---
title: Limit Order Books
authors: Gould, M. D., Porter, M. A., Williams, S., McDonald, M., Fenn, D. J. and Howison, S. D.
year: 2013
venue: Quantitative Finance 13(11), pp. 1709–1742
doi: 10.1080/14697688.2013.803148
url: https://arxiv.org/abs/1012.0349
area: systems
status: implemented
reviewed: false
citationVerified: true
summary: The definitions behind our order book and its price-time priority matching.
seeAlso: dean-barroso-2013-tail-at-scale
order: 30
---

## Research question
What is a limit order book, how do its rules work, and what do we know empirically and theoretically about how order books behave?

## Problem they solved
Limit order books are studied by economists, physicists and engineers, each with its own terms. The paper
is a survey that fixes a common vocabulary (orders, bid and ask, tick size, priority rules) and reviews the
empirical facts and the models of how order books behave.

## What they did
- Define a limit order book as the set of active orders, with the best bid and best ask on each side.
- Describe matching: an incoming order that crosses the opposite best price trades against it; what is
  left rests in the book.
- Describe priority rules, noting that **price-time** is by far the most common: best price first, and at
  the same price the earliest order first (Section 3.4). Pro-rata is an alternative.

## Findings
As a survey, the paper reports that price-time priority is by far the most common priority mechanism in current markets, and reviews empirical regularities of order flow and book depth together with the models proposed to explain them.

## What we took
- Price-time priority, exactly as defined there.
- Trades happen at the **resting** order's price; the unmatched remainder of the incoming order rests.

## What we changed or rejected
- Rejected pro-rata matching (it suits some futures markets, not an equity-style book).
- Not built yet: market orders, cancel and modify.
- Gould et al. define prices as whole multiples of a **tick size**. We still use `double` prices, which
  can produce rounding surprises. Integer ticks are on the open-issues list.
- `symbol_id` is ignored: every order goes into one book (one synthetic instrument).

## Where in our code
- `matching-engine/include/order_book.hpp` — bids in `std::map<double, std::deque<Order>, std::greater<double>>`,
  asks in `std::map<double, std::deque<Order>>`. The map gives price order, the deque gives time order.
- `matching-engine/src/order_book.cpp` — `OrderBook::match()` and `insert_resting()`.

## How we verified it
**Not verified by a dedicated test yet.** The book is exercised by the telemetry engine and watched in the
dashboard, but there is no unit test with hand-worked orders. Planned: a test that checks partial fills,
time priority at one price level and the trade price.

## Result
Not applicable (a correctness property, not a performance one).

## Limits and trade-offs
- `std::map` plus `std::deque` means pointer chasing on the hottest path. A dense, cache-aligned array of
  price levels indexed by tick is planned (differentiator 3 in our plan).
- Doubles as map keys: two prices that should be equal can differ in the last bit.
