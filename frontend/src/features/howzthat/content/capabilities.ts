import type { Status } from "./overview";

// ---- 06 Capabilities -------------------------------------------------------------------------------------

export type Capability = { title: string; text: string; why: string; status: Status };

export const CAPABILITIES: Capability[] = [
  { title: "Run the virtual traders", text: "Start, pause, stop and reset the 24 virtual traders from the header, at 1x, 10x or 100x activity. The C++ engine itself is always on.", why: "Lets you watch matching under different loads.", status: "implemented" },
  { title: "Place an order", text: "The order ticket sends a BUY or SELL with quantity and limit price to the engine, after a scenario preview of how similar positions ended in the past.", why: "Shows price-time priority with an order you control.", status: "implemented" },
  { title: "Inspect the book and trades", text: "Live bid/ask depth, a trade tape and the 24 virtual traders' paper-money cash, holdings and realized profit.", why: "See exactly how orders rest and match.", status: "implemented" },
  { title: "Operational telemetry", text: "Orders per second, queue depth, CPU, memory and a latency histogram with p50/p99, from the engine's own stats.", why: "Makes the concurrency visible.", status: "implemented" },
  { title: "Honest offline state", text: "Without exchange-api, engine panels show empty states instead of invented numbers, and reconnect automatically.", why: "The dashboard never pretends sample data is live.", status: "implemented" },
  { title: "Market data", text: "Search the S&P 500 and view real intraday prices as line or candlestick charts.", why: "Real market context next to the simulated engine market.", status: "implemented" },
  { title: "Journey", text: "How a stock moved over 1D to 1Y: rule-based story, biggest falls and rises, volume spikes and VWAP.", why: "Puts risk and return side by side over different horizons.", status: "implemented" },
  { title: "Research documentation", text: "This page, paper pages with code references, and an integrated paper exportable as PDF.", why: "Every design choice is traceable to a source and to code.", status: "implemented" },
  { title: "Risk-aware presentation", text: "Daily / 30 days / 1 year windows, a volatility-scaled Y-axis, log/linear scaling, and the return shown beside the worst fall.", why: "Reduces the distortions described in section 02.", status: "implemented" },
  { title: "Positions and profit/loss", text: "The virtual traders have cash, holdings and realized profit from real fills. The Journey view's own trading-activity fields (bought, sold, average price, unrealized P&L) are still empty \"NEEDS LEDGER\" fields.", why: "The user's own account is not built.", status: "partial" },
  { title: "Market orders and modify", text: "Only limit orders exist today. Cancel is supported.", why: "Needed for realistic order flow.", status: "planned" },
  { title: "Several instruments", text: "The engine trades 30 symbols, each with its own book.", why: "Valid symbol ids are 1 to 1000.", status: "implemented" },
  { title: "Durable trade history", text: "Every trade is stored in the Rust database and survives a restart; the engine replays its log to rebuild the book. A power cut is not covered (no fsync yet).", why: "Needs fsync / group commit for full durability.", status: "partial" },
];
