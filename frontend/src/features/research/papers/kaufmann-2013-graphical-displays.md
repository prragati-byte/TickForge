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
The way a price chart is drawn is not cosmetic: it changes how risky an asset feels. The Journey chart now
has a **Linear / Log** scale switch, and MAX opens on a log scale, where equal heights mean equal percentage
moves. On a linear scale, decades of growth make every early fall look flat and every recent wobble look huge.

## What we changed or rejected
- We did not build their risk tool or experience sampling. The planned "scenario visualizer before an
  order" is the closer match.
- The planned "smart Y-axis scaled from volatility" is not built. A log scale is a simpler, standard choice.

## Where in our code
`frontend/src/Journey.tsx` — the `log` prop of `JourneyChart` and the Price scale buttons.

## How we verified it
Not verified with users.

## Result
**No claim** about behaviour; this is a design choice informed by the paper.

## Limits and trade-offs
A log scale is less familiar to some readers, so the chart labels its scale and the user can switch back.

## Citation notes
The SAFE Frankfurt listing of this paper names the authors as Haisley, Laudenbach and Weber (Laudenbach
appears to be Christine Kaufmann's later surname). Confirm the author order on the publisher page before
submitting.
