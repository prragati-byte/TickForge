---
title: Myopic Loss Aversion and the Equity Premium Puzzle
authors: Benartzi, S. and Thaler, R. H.
year: 1995
venue: The Quarterly Journal of Economics 110(1), pp. 73–92
doi: 10.2307/2118511
area: behavioral
status: partial
reviewed: false
citationVerified: true
summary: How often you look at returns changes how risky an investment feels. Basis for the Journey ranges.
seeAlso: kaufmann-2013-graphical-displays
order: 110
---

## Research question
Can loss aversion combined with frequent evaluation of returns explain why stocks have earned so much more than bonds?

## Problem they solved
Stocks have paid far more than bonds over long periods (the equity premium), more than standard models of
risk aversion can explain.

## What they did
They combine two ideas: **loss aversion** (a loss hurts more than an equal gain pleases) and **frequent
evaluation** (even long-term investors check their portfolio often). They call the combination myopic loss
aversion. In their simulations, investors who evaluate their portfolio about **once a year** would be roughly
indifferent between stocks and bonds at the historical premium.

## Findings
In the authors' simulations, the size of the historical equity premium is consistent with investors who are loss averse and evaluate their portfolios about once a year.

## What we took
The evaluation window matters: the same asset looks frightening day by day and much calmer over years. So
the Journey view lets you look at one stock over 1D, 5D, 1M, 6M, 1Y and **MAX**, and MAX shows calendar-year
returns and how long each big fall took to recover.

## What we changed or rejected
- The paper is about evaluating a whole portfolio. Our Journey view is about one stock's history.
- The planned feature closest to the paper, a "daily noise vs long-term growth" toggle on the **user's own
  profit and loss**, needs the paper-trading ledger, which is not built.

## Where in our code
- `frontend/src/Journey.tsx` — `RANGES` (including MAX) and the Since listing panel (`SinceListing`).
- `market-data/journey.py` — `compute_long_term()`: calendar-year returns, drawdown episodes with recovery
  times, CAGR.

## How we verified it
The analytics are covered by tests with hand-calculated values in `market-data/test_journey.py`
(for example the drawdown episodes and partial-year handling). This checks the numbers, not the
behavioural effect.

## Result
No user study, so **no claim** that TickForge changes anyone's behaviour.

## Limits and trade-offs
- Survivorship bias: the symbol list is today's S&P 500, so long-run histories look better than the market
  as a whole. The page says so on screen.
- Prices are split- and dividend-adjusted, so early prices look tiny.
