// ---- 07 Evaluation -----------------------------------------------------------------------------------------

export type Experiment = {
  id: string;
  title: string;
  hypothesis: string;
  baseline: string;
  variable: string;
  metric: string;
  procedure: string;
  interpretation: string;
  status: "not-measured" | "blocked" | "optional";
  needs: string;
};

export const EXPERIMENTS: Experiment[] = [
  {
    id: "throughput",
    title: "Queue throughput: lock-free vs mutex",
    hypothesis: "With several producers, the lock-free MPSC queue sustains more orders per second than a mutex-protected queue.",
    baseline: "A std::mutex + std::queue, and Michael and Scott's own two-lock queue.",
    variable: "Queue implementation; number of producer threads (1, 2, 4, 8).",
    metric: "Orders per second (median of repeated runs), CAS retries per order.",
    procedure: "Closed-loop producers enqueue a fixed number of orders; one consumer drains; same machine, same build flags, several repetitions.",
    interpretation: "A gap that grows with producer count supports the design; no gap means the queue is not the bottleneck.",
    status: "not-measured",
    needs: "benchmarks/lockfree_vs_mutex_bench.cpp exists but is empty; CAS counters are not instrumented.",
  },
  {
    id: "latency",
    title: "Order-to-match latency percentiles",
    hypothesis: "The lock-free path has a lower and tighter P99 / P99.99 than the mutex baseline.",
    baseline: "Same engine with the mutex queue.",
    variable: "Queue implementation; offered load.",
    metric: "P50, P99, P99.99 of submit-to-matched time.",
    procedure: "Open-loop load generator at fixed rates; record every sample in a fine-grained histogram.",
    interpretation: "Compare tails, not averages; report the machine and load used.",
    status: "not-measured",
    needs: "Today's histogram has power-of-two buckets and the telemetry engine is rate-limited (40 orders/s × speed), so it is monitoring, not a benchmark. Needs an HDR-style histogram and an unthrottled load generator.",
  },
  {
    id: "burst",
    title: "Burst load",
    hypothesis: "Queue depth recovers quickly after a burst and P99 stays bounded.",
    baseline: "Steady load at the same average rate.",
    variable: "Burst size and duration.",
    metric: "Peak queue depth, time to drain, P99 during and after the burst.",
    procedure: "Inject bursts from all producers; sample queue depth and latency every few milliseconds.",
    interpretation: "Shows whether an unbounded queue hides overload (memory growth) instead of handling it.",
    status: "not-measured",
    needs: "A burst mode in the load generator.",
  },
  {
    id: "pinning",
    title: "Pinned vs unpinned matching thread",
    hypothesis: "Pinning the matcher to an isolated core lowers P99.",
    baseline: "Unpinned matcher.",
    variable: "Core affinity on/off.",
    metric: "P99 and P99.99 latency.",
    procedure: "Same load, with and without affinity, on an otherwise idle machine.",
    interpretation: "Quantifies scheduler jitter on this machine.",
    status: "blocked",
    needs: "Core affinity is not implemented.",
  },
  {
    id: "compaction",
    title: "WAL latency with compaction on and off",
    hypothesis: "Activity-aware throttling removes the latency spikes compaction causes.",
    baseline: "Compaction off; default (unthrottled) compaction.",
    variable: "Compaction policy.",
    metric: "WAL write latency percentiles; matching P99 during compaction.",
    procedure: "Sustained write load long enough to trigger several compactions.",
    interpretation: "Must be compared against SILK's results and approach.",
    status: "blocked",
    needs: "The WAL and storage engine do not exist yet.",
  },
  {
    id: "replay",
    title: "Crash and replay correctness",
    hypothesis: "Replaying the log after a crash rebuilds exactly the pre-crash book.",
    baseline: "State hash of the book just before the crash.",
    variable: "Crash point (random).",
    metric: "Hash equality of book and trade log; recovery time.",
    procedure: "Kill the engine at random points many times; recover; compare hashes.",
    interpretation: "Any mismatch is a correctness bug, not a performance issue.",
    status: "blocked",
    needs: "Needs the WAL, snapshots and replay.",
  },
  {
    id: "ux",
    title: "Behaviour-aware UI study (optional)",
    hypothesis: "Long evaluation windows and dual framing reduce panic exits without lowering understanding.",
    baseline: "A plain daily view without these features.",
    variable: "UI variant.",
    metric: "Panic exits, self-reported confidence, recall of risk.",
    procedure: "Small within-subject study on simulated price paths.",
    interpretation: "Small samples only indicate direction; no general claims.",
    status: "optional",
    needs: "Ethics and consent for a user study; the ledger for P&L variants.",
  },
];

/** Results table, ready for real numbers. A null value renders as "Not yet measured". */
export type ResultRow = { metric: string; baseline: number | null; tickforge: number | null; unit: string; experiment: string };

export const RESULTS: ResultRow[] = [
  { metric: "Throughput, 4 producers", baseline: null, tickforge: null, unit: "orders/s", experiment: "throughput" },
  { metric: "Throughput, 8 producers", baseline: null, tickforge: null, unit: "orders/s", experiment: "throughput" },
  { metric: "P50 order-to-match latency", baseline: null, tickforge: null, unit: "µs", experiment: "latency" },
  { metric: "P99 order-to-match latency", baseline: null, tickforge: null, unit: "µs", experiment: "latency" },
  { metric: "P99.99 order-to-match latency", baseline: null, tickforge: null, unit: "µs", experiment: "latency" },
  { metric: "Peak queue depth during burst", baseline: null, tickforge: null, unit: "orders", experiment: "burst" },
];

/** Correctness evidence that does exist (not performance). Re-run on Linux, 16 Oct 2026. */
export const EVIDENCE: { title: string; result: string; how: string }[] = [
  { title: "Queue stress test", result: "PASS · 1,600,000 / 1,600,000 messages", how: "8 producers × 200,000, one consumer: nothing lost, nothing duplicated, per-producer order kept." },
  { title: "ThreadSanitizer", result: "PASS · no reports (800,000 messages)", how: "Same stress test built with -fsanitize=thread." },
  { title: "AddressSanitizer", result: "PASS · no reports (800,000 messages)", how: "Same stress test built with -fsanitize=address: no use-after-free in reclamation." },
  { title: "Market-data analytics", result: "34 tests · 27 re-run and passing", how: "Hand-calculated expected values for the Journey and MAX analytics; deliberately broken versions of the code are caught. The 7 API tests need FastAPI and were not re-run in this sandbox." },
];

// ---- 09 Limitations and future work --------------------------------------------------------------------

export const LIMITATIONS = [
  "No performance result has been measured against a baseline yet.",
  "No persistence: trades are lost when the engine stops.",
  "One synthetic instrument; symbol_id is ignored; prices are doubles, not integer ticks.",
  "Limit orders only: no market orders, cancels or modifications.",
  "Latency percentiles are power-of-two bucket bounds; no p99.9 / p99.99.",
  "The trade tape can skip trades at high speed (15 per 250 ms).",
  "The engine has only been built and tested on Linux.",
  "The research pages are drafts until a teammate who has read each paper signs them off.",
  "Long-run stock histories use today's S&P 500, so they carry survivorship bias.",
];
