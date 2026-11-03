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
    responsibility: "Creates orders. The 24 virtual traders in exchange-api send small limit orders around the last trade price of the symbols the engine trades (paper money, speed 1x/10x/100x), and the dashboard's order ticket sends manual orders.",
    problem: "Gives the engine a controllable load of orders from traders that own cash and shares, and lets a person place an order by hand.",
    talksTo: "Browser → exchange-api → engine (TCP 127.0.0.1:9100, newline-delimited JSON) → a connection thread on the engine.",
    status: "implemented",
    files: ["services/exchange-api/app/traders.py", "services/exchange-api/app/engine_client.py", "frontend/src/features/dashboard/OrderTicket.tsx (order ticket)"],
  },
  {
    id: "validation",
    name: "Validation",
    responsibility: "exchange-api checks the fields of every order before it goes to the engine; the engine checks again (maximum quantity, price band).",
    problem: "No browser text ever reaches the engine directly; only localhost pages on the allowed origins can connect.",
    talksTo: "Browser → exchange-api (HTTP and WebSocket, 127.0.0.1:8001) → engine (TCP, 127.0.0.1:9100).",
    status: "implemented",
    files: ["services/exchange-api/app/routes.py (post_order)", "engine/src/engine_server.cpp (connection threads)"],
  },
  {
    id: "ingestion",
    name: "Concurrent ingestion",
    responsibility: "Connection threads validate an order, write it to the write-ahead log, acknowledge it and push it onto a lock-free multi-producer / single-consumer queue that the matcher drains.",
    problem: "Producers hand work to the matcher without blocking it on the queue. (One short lock covers sequence number, log write and ack, so queue order equals log order.)",
    talksTo: "Connection threads enqueue; the matching thread dequeues.",
    status: "implemented",
    files: ["engine/include/lock_free_queue.hpp (MPSCQueue)", "engine/src/engine_server.cpp"],
  },
  {
    id: "matcher",
    name: "Matching engine",
    responsibility: "One thread takes orders in arrival order, matches each against the book, and reports trades to every connected client. When the queue is empty it sleeps on a condition variable (idle CPU measured at 0.2%).",
    problem: "A single writer means the books need no locks and results are repeatable for a given input order.",
    talksTo: "Dequeues from the queue, matches against the book of the order's symbol, sends trade messages.",
    status: "implemented",
    files: ["engine/src/engine_server.cpp (matching thread)"],
  },
  {
    id: "book",
    name: "Limit order book · price-time priority",
    responsibility: "One book per symbol (30 symbols), prices in integer cents. Holds resting orders: bids and asks in maps keyed by price, each level a FIFO queue. Best price first, oldest order first; partial fills; trades at the resting price; the remainder rests; cancel supported. A dense-array book with the same interface exists for the benchmark; the server uses the map book.",
    problem: "The standard, fair priority rule for an equity-style book.",
    talksTo: "Called only from the matching thread; the book snapshot goes out in the engine's book reply.",
    status: "implemented",
    files: ["engine/include/map_book.hpp", "engine/include/dense_book.hpp", "engine/tests/order_book_tests.cpp"],
  },
  {
    id: "telemetry",
    name: "Trades and market-data updates",
    responsibility: "The engine answers a stats request with orders/s, trades, queue depth, a 16-bucket latency histogram with p50/p99, CPU and memory. exchange-api polls it and, once a second, pushes it with the book and new trades to the browser over /ws/telemetry.",
    problem: "Makes the engine observable without touching the matching logic.",
    talksTo: "Engine stats reply → exchange-api → WebSocket → dashboard. There is no separate bridge process.",
    status: "implemented",
    files: ["engine/src/engine_server.cpp (stats)", "services/exchange-api/app/main.py", "frontend/src/lib/telemetry.ts"],
  },
  {
    id: "api",
    name: "Backend / market-data API",
    responsibility: "FastAPI service with GET /api/stocks/{symbol} and GET /api/stocks/{symbol}/journey: real Yahoo Finance prices, a range/interval whitelist, a cache (30 s), a 10 s timeout on Yahoo calls and rule-based Journey analytics.",
    problem: "Real market context next to the simulated engine market, with every number unit-tested.",
    talksTo: "Browser → HTTP (127.0.0.1:8000) → yfinance. Independent of the engine: the engine's prices come from the virtual traders' orders, not from these stocks.",
    status: "implemented",
    files: ["services/market-data/app/main.py", "services/market-data/app/stocks.py", "services/market-data/app/journey.py"],
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
    responsibility: "The engine writes every accepted input to a CRC-protected write-ahead log before acknowledging it and replays the log on restart to rebuild the exact book (state_hash proves it). exchange-api stores every trade in the Rust LSM database (tickforge_db): memtable, binary SSTables with a sparse index, Bloom filter and CRC-32 footer, and one size-tiered compaction.",
    problem: "Trades and the book survive a restart. The log survives a killed process but not a power cut (no fsync / group commit yet).",
    talksTo: "Engine → its WAL file. exchange-api → tickforge_db, imported as a Python module.",
    status: "partial",
    files: ["engine/src/wal.cpp","engine/tests/wal_recovery_test.cpp", "storage/src/database.rs", "services/exchange-api/app/db.py"],
  },
  {
    id: "future",
    name: "Storage not built yet",
    responsibility: "fsync / group commit for the engine log, snapshots, an atomic MemTable swap, a per-table id index for get_trade, compaction throttled by queue depth, read benchmarks and a B+tree baseline benchmark.",
    problem: "Durability across a power cut, faster recovery, and no compaction spikes on the matching path.",
    talksTo: "—",
    status: "planned",
    files: [],
  },
];

// Architecture diagram: what runs today, and what is only designed. Labels must match COMPONENTS.
export type FlowNode = { label: string; detail: string; status: Status; component?: string };

export const ENGINE_FLOW: FlowNode[] = [
  { label: "Virtual traders + order ticket", detail: "24 traders · manual orders", status: "implemented", component: "submission" },
  { label: "Validation", detail: "exchange-api + engine", status: "implemented", component: "validation" },
  { label: "WAL then MPSC queue", detail: "logged, acked, lock-free", status: "implemented", component: "ingestion" },
  { label: "Matching thread", detail: "single consumer", status: "implemented", component: "matcher" },
  { label: "Order book", detail: "price-time priority", status: "implemented", component: "book" },
  { label: "Stats", detail: "polled, pushed every 1 s", status: "implemented", component: "telemetry" },
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
  { label: "Write-ahead log", detail: "built · no fsync yet", status: "partial", component: "persistence" },
  { label: "MemTable → SSTables", detail: "Rust · tickforge_db", status: "implemented", component: "persistence" },
  { label: "Compaction", detail: "size-tiered built · throttling planned", status: "partial", component: "persistence" },
  { label: "Replay recovery", detail: "state hash checked", status: "implemented", component: "persistence" },
];
