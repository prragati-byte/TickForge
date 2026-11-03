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
  status: "first-run" | "not-measured" | "blocked" | "optional";
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
    status: "first-run",
    needs: "First run done (engine/bench, results in docs/BENCHMARKS.md): the lock-free queue did NOT beat the mutex queue on raw throughput. Still missing: CAS retry counters, repeated runs, other machines.",
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
    status: "first-run",
    needs: "The benchmark measures the time inside enqueue() (P50 and P99), not order-to-match latency, and the engine's live histogram has power-of-two buckets. Needs an HDR-style histogram for P99.99 and an unthrottled order-to-match load generator.",
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
    status: "first-run",
    needs: "Measured for the queues alone (docs/BENCHMARKS.md). A burst mode in the whole-server load generator is still missing.",
  },
  {
    id: "pinning",
    title: "Pinned vs unpinned matching thread",
    hypothesis: "Pinning the matcher to an isolated core lowers P99.",
    baseline: "Unpinned matcher.",
    variable: "Core affinity on/off.",
    metric: "P99 and P99.99 latency.",
    procedure: "Same load, with and without affinity, on an otherwise idle machine.",
    interpretation: "Quantifies scheduler jitter on this machine. Result: no measurable gain and a slightly worse tail in the longest run (docs/BENCHMARKS.md), so it is off by default; on WSL2 the pin is to a virtual CPU.",
    status: "first-run",
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
    status: "not-measured",
    needs: "The WAL and the database exist, but no experiment times WAL writes or matching latency while a compaction runs. Throttled compaction is not built.",
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
    status: "first-run",
    needs: "Done for process kills: engine/tests/wal_recovery_test.cpp and engine/tests/engine_e2e_test.cpp (kill -9, same state hash after restart). Missing: random crash points repeated many times, recovery time, power-cut durability (no fsync).",
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
    needs: "Ethics and consent for a user study; a ledger for the user's own P&L variants.",
  },
];

/**
 * Results table. Numbers are copied from docs/BENCHMARKS.md (run of 2026-11-03, one machine, threads not pinned).
 * A null value renders as "Not yet measured".
 */
export type ResultRow = { metric: string; baseline: number | null; tickforge: number | null; unit: string; experiment: string };

export const RESULTS: ResultRow[] = [
  { metric: "Queue throughput, 4 producers", baseline: 4.99, tickforge: 3.7, unit: "M items/s", experiment: "throughput" },
  { metric: "Queue throughput, 8 producers", baseline: 3.66, tickforge: 2.41, unit: "M items/s", experiment: "throughput" },
  { metric: "Enqueue P50, 4 producers", baseline: 45, tickforge: 432, unit: "ns", experiment: "latency" },
  { metric: "Enqueue P99, 4 producers", baseline: 20564, tickforge: 3920, unit: "ns", experiment: "latency" },
  { metric: "Enqueue P99, 8 producers", baseline: 45319, tickforge: 26537, unit: "ns", experiment: "latency" },
  { metric: "P99.99 order-to-match latency", baseline: null, tickforge: null, unit: "µs", experiment: "latency" },
  { metric: "Peak queue depth during burst", baseline: null, tickforge: null, unit: "orders", experiment: "burst" },
];

/** Correctness evidence from the test suite (./build.sh test), re-run on Linux (WSL2) on 3 Nov 2026. */
export const EVIDENCE: { title: string; result: string; how: string }[] = [
  { title: "Engine tests (ctest)", result: "PASS · 19 / 19", how: "Order book, WAL recovery, queue stress, engine end-to-end with kill -9, core pinning, the elastic ring, the WAL through io_uring and leader to follower replication. The queue, the elastic ring and the server with kill -9 also run under ThreadSanitizer and under AddressSanitizer." },
  { title: "Crash recovery", result: "PASS · same state hash after kill -9", how: "engine/tests/wal_recovery_test.cpp: replay equals live, file cut at every byte offset, bit-flip detection, writer killed with SIGKILL. The end-to-end test kills the server and compares the hash after restart." },
  { title: "Database tests", result: "PASS · 28 Rust + 8 Python", how: "Memtable, SSTable (every byte flipped is caught), Bloom filter, compaction, and the TickForgeDB Python module." },
  { title: "Service and frontend tests", result: "PASS · 17 + 19 + 26", how: "exchange-api pytest 17, market-data pytest 19 (Yahoo is mocked, no network), frontend typecheck and vitest 26." },
];

// ---- 09 Limitations and future work --------------------------------------------------------------------

export const LIMITATIONS = [
  "The queue and book benchmarks are a first run on one machine with unpinned threads. The lock-free queue did not beat the mutex queue on raw throughput; only its enqueue P99 was lower at 4 and 8 producers.",
  "The engine log is not fsynced: it survives a killed process but not a power cut. No snapshots.",
  "The database has no per-table id index (get_trade scans), no read benchmarks, and compaction is not throttled by queue depth.",
  "Limit orders only: no market orders or modifications (cancel is supported).",
  "The server uses the std::map book; the faster dense-array book only accepts a fixed price range.",
  "Latency percentiles are power-of-two bucket bounds; no p99.9 / p99.99.",
  "Built but not the default, because they measured slower or no better here: core pinning, io_uring, the elastic dual ring, leader to follower replication (asynchronous, localhost only, no automatic failover).",
  "Not built: eBPF/XDP, memory pools, huge pages, FIX/SBE message encoding.",
  "The virtual traders use paper money, and resting orders do not reserve cash or shares.",
  "The engine has only been built and tested on Linux (WSL2).",
  "The research pages are drafts until a teammate who has read each paper signs them off.",
  "Long-run stock histories use today's S&P 500, so they carry survivorship bias.",
];
