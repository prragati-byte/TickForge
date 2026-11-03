---
title: The Role of Experience Sampling and Graphical Displays on One's Investment Risk Appetite
authors: Kaufmann, C., Weber, M. and Haisley, E.
year: 2013
venue: Management Science 59(2), pp. 323–340
doi: 10.1287/mnsc.1120.1607
area: behavioral
status: partial
reviewed: false
citationVerified: true
summary: How a chart is drawn changes how risky it feels. Why the price scale is a design decision.
seeAlso: benartzi-thaler-1995-myopic-loss-aversion
order: 120
---

## Research question
How do different ways of presenting investment risk change how much risk people take and how well they understand it?

## Problem they solved
Investors often misjudge the risk of investment products, partly because of how risk is presented to them.

## What they did
In experiments, participants split money between a risky and a risk-free fund after seeing the risk in
different formats: numbers, graphs, **experience sampling** (drawing simulated outcomes one by one), or a
combined risk tool. With experience sampling and the risk tool, people took more risk, understood the
risk-return profile better, and were not more dissatisfied with the outcomes afterwards.

## Findings
The authors report that participants allocated more to the risky fund with experience sampling and with the combined risk tool; with the risk tool they also perceived less risk, estimated the probability of loss more accurately, and were not more dissatisfied with their returns later.

## What we took
The way a price chart is drawn is not cosmetic: it changes how risky an asset feels. Two things follow in the app. The Y-axis of
the market chart is **scaled to the volatility** of the series by default (with a "Fit to data" switch), and the Journey chart has a **Linear / Log**
scale switch (on a log scale equal heights mean equal percentage moves). The order ticket also shows a
**scenario preview** before an order is confirmed: a histogram of how past holding periods of the chosen
length ended.

## What we changed or rejected
- We did not build their risk tool or experience sampling. The scenario preview is the closest match: it
  shows a spread of past outcomes at once, not drawn one by one.

## Where in our code
- `frontend/src/lib/behavior.ts` — `volatilityAxis()` and `scenarioOutcomes()`.
- `frontend/src/features/dashboard/OrderTicket.tsx` — the scenario preview.
- `frontend/src/features/journey/Journey.tsx` — the Linear / Log switch.

## How we verified it
`frontend/src/lib/behavior.test.ts` tests `volatilityAxis()` and `scenarioOutcomes()`. Not verified with users.

## Result
**No claim** about behaviour; this is a design choice informed by the paper.

## Limits and trade-offs
A log scale is less familiar to some readers, so the chart labels its scale and the user can switch back.

## Citation notes
The SAFE Frankfurt listing of this paper names the authors as Haisley, Laudenbach and Weber (Laudenbach
appears to be Christine Kaufmann's later surname). Confirm the author order on the publisher page before
submitting.
