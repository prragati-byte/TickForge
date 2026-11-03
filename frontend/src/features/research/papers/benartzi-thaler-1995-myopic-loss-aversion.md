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
summary: How often you look at returns changes how risky an investment feels. Basis for the evaluation windows and Journey ranges.
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
the market panel has a **Daily / 30 days / 1 year** toggle that shows the window's return next to its worst fall,
and the Journey view lets you look at one stock over its ranges up to 1Y.

## What we changed or rejected
- The paper is about evaluating a whole portfolio. Our windows apply to one stock's price history.
- The feature closest to the paper, a "daily noise vs long-term growth" toggle on the **user's own
  profit and loss**, is not built. The 24 virtual traders do have paper-money P&L, but the toggle does not use it.
- The market-data MAX range is not available, so the MAX button is hidden.

## Where in our code
- `frontend/src/features/market/MarketSection.tsx` — the evaluation-window toggle.
- `frontend/src/lib/behavior.ts` — `periodReturnPct()` and `maxDrawdownPct()`.
- `frontend/src/features/journey/Journey.tsx` and `services/market-data/app/journey.py` — the Journey ranges
  and analytics.

## How we verified it
`frontend/src/lib/behavior.test.ts` tests the return and drawdown calculations, and
`services/market-data/tests/test_journey.py` tests the Journey analytics with hand-calculated values.
This checks the numbers, not the behavioural effect.

## Result
No user study, so **no claim** that TickForge changes anyone's behaviour.

## Limits and trade-offs
- Survivorship bias: the symbol list is today's S&P 500, so long-run histories look better than the market
  as a whole. The page says so on screen.
- Prices are split- and dividend-adjusted, so early prices look tiny.
