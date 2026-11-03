import type { Status } from "./overview";

// ---- 06 Capabilities -------------------------------------------------------------------------------------

export type Capability = { title: string; text: string; why: string; status: Status };

export const CAPABILITIES: Capability[] = [
  { title: "Run the engine", text: "Start, pause, stop and reset the real C++ engine from the header, at 1x, 10x or 100x order rate.", why: "Lets you watch matching under different loads.", status: "implemented" },
  { title: "Place an order", text: "The order ticket sends a BUY or SELL with quantity and limit price to the engine.", why: "Shows price-time priority with an order you control.", status: "implemented" },
  { title: "Inspect the book and trades", text: "Live bid/ask depth, a trade tape and producer activity.", why: "See exactly how orders rest and match.", status: "implemented" },
  { title: "Operational telemetry", text: "Orders per second, queue depth, CPU, memory and a latency histogram with p50/p99.", why: "Makes the concurrency visible.", status: "implemented" },
  { title: "Honest offline state", text: "Without exchange-api, engine panels show empty states instead of invented numbers, and reconnect automatically.", why: "The dashboard never pretends sample data is live.", status: "implemented" },
  { title: "Market data", text: "Search the S&P 500 and view real intraday prices as line or candlestick charts.", why: "Real market context next to the synthetic engine.", status: "implemented" },
  { title: "Journey", text: "How a stock moved over 1D to MAX: rule-based story, biggest falls and rises, volume spikes, VWAP, and for MAX the since-listing view.", why: "Puts risk and return side by side over different horizons.", status: "implemented" },
  { title: "Research documentation", text: "This page, paper pages with code references, and an integrated paper exportable as PDF.", why: "Every design choice is traceable to a source and to code.", status: "implemented" },
  { title: "Risk-aware presentation", text: "Log/linear scaling and long evaluation windows on market history.", why: "Reduces the distortions described in section 02.", status: "partial" },
  { title: "Complete trade tape at high speed", text: "The tape shows at most 15 trades per 250 ms, so at 100x some trades are not displayed (they still happen in the engine).", why: "Any P&L feature will need every fill.", status: "partial" },
  { title: "Positions and profit/loss", text: "Bought, sold, average price, realized/unrealized P&L. Shown as empty \"NEEDS LEDGER\" fields today.", why: "Needs a paper-trading ledger fed by every fill.", status: "planned" },
  { title: "Cancel, modify and market orders", text: "Only limit orders exist today.", why: "Needed for realistic order flow.", status: "planned" },
  { title: "Several instruments", text: "Today every order goes into one book for one synthetic instrument.", why: "symbol_id is carried but ignored.", status: "planned" },
  { title: "Durable trade history", text: "Trades are lost when the engine stops.", why: "Needs the WAL and storage engine.", status: "planned" },
];
