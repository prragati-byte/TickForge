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
- Not built: market orders and modify. Limit orders and cancel are supported.
- Gould et al. define prices as whole multiples of a **tick size**. We use integer cents (`int64`), so
  prices are exact; the tick is one cent.
- One book per symbol; the engine accepts symbol ids 1 to 1000 and trades 30 symbols.

## Where in our code
- `engine/include/map_book.hpp` — the `std::map` book, the one the server uses. The map gives price
  order, a FIFO queue per price level gives time order.
- `engine/include/dense_book.hpp` — a cache-aligned array with one level per cent, behind the same
  interface. It only accepts a fixed price range.

## How we verified it
`engine/tests/order_book_tests.cpp` checks partial fills (the rest of the resting order stays and the
trade prints at its price), price priority, time priority at one price level and cancel. It also feeds
the same random orders to both books and checks that trades and the state hash are identical.
`engine/tests/engine_e2e_test.cpp` checks the same rules through the TCP server.

## Result
Correctness: the tests pass. For speed, `engine/bench/last_run.md` (1,000,000 operations, one thread):
dense book 14.82 M ops/s (P50 84 ns, P99 347 ns) against 10.12 M ops/s (P50 114 ns, P99 402 ns)
for the map book. One machine, threads not pinned.

## Limits and trade-offs
- The server still uses the `std::map` book, which chases pointers on the hottest path, because the
  dense book cannot take arbitrary prices.
- The benchmark prices stay within ±10 cents of a drifting mid price, which suits the dense book.
