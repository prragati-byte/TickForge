import type { Status } from "./overview";

// ---- 04 How TickForge works --------------------------------------------------------------------------

export type Component = {
  id: string;
  name: string;
  responsibility: string;
  problem: string;
  talksTo: string;
  status: Status;
  files: string[];
};

export const COMPONENTS: Component[] = [
  {
    id: "submission",
    name: "Order submission",
    responsibility: "Creates orders. Four producer threads generate synthetic buy/sell orders around $150 (40 orders/s × the 1x/10x/100x speed), and the dashboard's order ticket sends manual orders.",
    problem: "Gives the engine a steady, controllable load and lets a person place an order by hand.",
    talksTo: "Producers call MatchingEngine::submit(). Ticket orders go browser → exchange-api → engine (TCP, JSON lines) → submit().",
    status: "implemented",
    files: ["matching-engine/src/telemetry_main.cpp (producer, submit_order, command_reader)", "frontend/src/features/dashboard/OrderTicket.tsx (order ticket)"],
  },
  {
    id: "validation",
    name: "Validation",
    responsibility: "exchange-api checks the fields of every order before it goes to the engine; the engine checks again (maximum quantity, price band).",
    problem: "No browser text ever reaches the engine directly; only localhost pages on the allowed origins can connect.",
    talksTo: "Browser → exchange-api (HTTP and WebSocket, 127.0.0.1:8001) → engine (TCP, 127.0.0.1:9100).",
    status: "implemented",
    files: ["services/exchange-api/app/routes.py (post_order)", "matching-engine/src/telemetry_main.cpp (command_reader)"],
  },
  {
    id: "ingestion",
    name: "Concurrent ingestion",
    responsibility: "A lock-free multi-producer / single-consumer queue between the producers and the matcher.",
    problem: "Producers never block one another or the matcher on a lock.",
    talksTo: "submit() enqueues; the matching thread dequeues.",
    status: "implemented",
    files: ["matching-engine/include/lock_free_queue.hpp (MPSCQueue)"],
  },
  {
    id: "matcher",
    name: "Matching engine",
    responsibility: "One thread takes orders in arrival order, matches each against the book, and reports trades and processed orders through callbacks. When the queue is empty it yields and polls again.",
    problem: "A single writer means the book needs no locks and results are repeatable for a given input order.",
    talksTo: "Dequeues from the queue, calls OrderBook::match(), fires the trade and order callbacks.",
    status: "implemented",
    files: ["matching-engine/include/matching_engine.hpp (MatchingEngine::run)"],
  },
  {
    id: "book",
    name: "Limit order book · price-time priority",
    responsibility: "Holds resting orders: bids best-first and asks best-first in maps keyed by price, each level a FIFO deque. Best price first, oldest order first; trades at the resting price; the remainder rests.",
    problem: "The standard, fair priority rule for an equity-style book.",
    talksTo: "Called only from the matching thread; depth() gives aggregated levels for telemetry.",
    status: "implemented",
    files: ["matching-engine/include/order_book.hpp", "matching-engine/src/order_book.cpp (match, insert_resting, depth)"],
  },
  {
    id: "telemetry",
    name: "Trades and market-data updates",
    responsibility: "Every 250 ms the telemetry driver prints one JSON line: orders/s, trades, queue depth, latency histogram with p50/p99, book depth, CPU, memory and up to 15 recent trades.",
    problem: "Makes the engine observable without touching the matching logic.",
    talksTo: "Trade and order callbacks on the matching thread → stats reply → exchange-api → WebSocket → dashboard.",
    status: "implemented",
    files: ["matching-engine/src/telemetry_main.cpp", "services/exchange-api/app/main.py", "frontend/src/lib/telemetry.ts"],
  },
  {
    id: "api",
    name: "Backend / market-data API",
    responsibility: "FastAPI service with GET /api/stocks/{symbol} and GET /api/stocks/{symbol}/journey: real Yahoo Finance prices, a range/interval whitelist, a bounded cache and rule-based Journey analytics.",
    problem: "Real market context next to the synthetic engine, with every number unit-tested.",
    talksTo: "Browser → HTTP (127.0.0.1:8000) → yfinance. Independent of the engine: the engine trades one synthetic instrument, not these stocks.",
    status: "implemented",
    files: ["market-data/main.py", "market-data/stocks.py", "market-data/journey.py"],
  },
  {
    id: "frontend",
    name: "Frontend",
    responsibility: "React dashboard (engine controls, book, trade tape, latency, market data, Journey) and this research page.",
    problem: "Shows what the engine is doing and puts market risk in context.",
    talksTo: "WebSocket and HTTP to exchange-api; HTTP to the market-data API. Shows empty states, not invented numbers, when exchange-api is offline.",
    status: "implemented",
    files: ["frontend/src/features/dashboard/Dashboard.tsx", "frontend/src/features/journey/Journey.tsx", "frontend/src/features/howzthat/HowzThatPage.tsx"],
  },
  {
    id: "persistence",
    name: "Persistence and recovery",
    responsibility: "Not implemented. Trades exist only in memory (the telemetry keeps a bounded buffer of recent trades). Nothing survives a restart.",
    problem: "—",
    talksTo: "—",
    status: "planned",
    files: [],
  },
  {
    id: "future",
    name: "Proposed storage infrastructure",
    responsibility: "Write-ahead log → single-writer MemTable → SSTables with Bloom filters, activity-aware compaction, snapshots and deterministic replay.",
    problem: "Durable trades and exact recovery after a crash, without compaction spikes on the matching path.",
    talksTo: "Would hang off the trade callback of the matching thread.",
    status: "planned",
    files: [],
  },
];

// Architecture diagram: what runs today, and what is only designed. Labels must match COMPONENTS.
export type FlowNode = { label: string; detail: string; status: Status; component?: string };

export const ENGINE_FLOW: FlowNode[] = [
  { label: "Producers + order ticket", detail: "4 threads · manual orders", status: "implemented", component: "submission" },
  { label: "Validation", detail: "exchange-api + engine", status: "implemented", component: "validation" },
  { label: "MPSC queue", detail: "lock-free · hazard pointers", status: "implemented", component: "ingestion" },
  { label: "Matching thread", detail: "single consumer", status: "implemented", component: "matcher" },
  { label: "Order book", detail: "price-time priority", status: "implemented", component: "book" },
  { label: "Telemetry", detail: "JSON every 250 ms", status: "implemented", component: "telemetry" },
  { label: "exchange-api WebSocket", detail: "127.0.0.1:8001", status: "implemented", component: "telemetry" },
  { label: "Dashboard", detail: "engine panels", status: "implemented", component: "frontend" },
];

export const MARKET_FLOW: FlowNode[] = [
  { label: "Yahoo Finance", detail: "via yfinance", status: "implemented", component: "api" },
  { label: "FastAPI service", detail: "whitelist · cache", status: "implemented", component: "api" },
  { label: "Journey analytics", detail: "rule-based, tested", status: "implemented", component: "api" },
  { label: "Dashboard", detail: "market + Journey", status: "implemented", component: "frontend" },
];

export const STORAGE_FLOW: FlowNode[] = [
  { label: "Trades", detail: "from the matcher", status: "implemented", component: "matcher" },
  { label: "Write-ahead log", detail: "not built", status: "planned", component: "future" },
  { label: "MemTable → SSTables", detail: "not built", status: "planned", component: "future" },
  { label: "Compaction", detail: "activity-aware · not built", status: "planned", component: "future" },
  { label: "Replay recovery", detail: "not built", status: "planned", component: "future" },
];
