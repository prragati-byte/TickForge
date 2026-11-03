// Content for the "how'z that!" research page (/howz-that).
//
// Sources of truth: the team's research document "TickForge: Problem Statement, Differentiators and
// Research Foundation" (the PDF) and the code in this repository. Every status below was checked against the
// code and by running the tests and benchmarks on 3 Nov 2026. Rule: nothing is "implemented" just because the PDF or the roadmap mentions it, and no
// performance number appears here unless it was measured.
//
// Paper pages live in ../research/papers/*.md; `papers` fields below are slugs of those files.

export type Status = "implemented" | "partial" | "planned" | "unverified";

export const STATUS_LABEL: Record<Status, string> = {
  implemented: "Implemented",
  partial: "Partially implemented",
  planned: "Planned",
  unverified: "Not verified",
};

export type SectionMeta = { id: string; number: string; title: string; short: string };

export const SECTIONS: SectionMeta[] = [
  { id: "big-picture", number: "01", title: "The big picture", short: "Big picture" },
  { id: "problem-statement", number: "02", title: "The problem statement", short: "Problem" },
  { id: "existing-work", number: "03", title: "Existing work and the research gap", short: "Existing work" },
  { id: "how-tickforge-works", number: "04", title: "How TickForge works", short: "How it works" },
  { id: "differentiators", number: "05", title: "What we added: engineering differentiators", short: "Differentiators" },
  { id: "capabilities", number: "06", title: "What TickForge provides", short: "Capabilities" },
  { id: "evaluation", number: "07", title: "Evaluation and evidence", short: "Evaluation" },
  { id: "paper-library", number: "08", title: "Research paper library", short: "Paper library" },
  { id: "limitations", number: "09", title: "Limitations and future work", short: "Limitations" },
  { id: "references", number: "10", title: "References and acknowledgments", short: "References" },
];

export const INTRO_POINTS = [
  "the problems TickForge addresses",
  "the research that informed the design",
  "the engineering decisions in the code",
  "what users can do with it today",
  "how the system should be evaluated",
  "its limitations and what comes next",
];

// ---- 01 The big picture ----------------------------------------------------------------------------

export const ABSTRACT =
  "TickForge is a small exchange built to study what happens on the critical path of order matching. Connection threads write each order to a write-ahead log, acknowledge it and hand it to a lock-free multi-producer / single-consumer queue; one matching thread applies price-time priority on limit order books and emits trades; the exchange-api service stores every trade in an LSM-tree database written in Rust and streams the engine's throughput, queue depth, book depth and latency histogram to a web dashboard. A separate Python service serves real stock histories from Yahoo Finance, with long-horizon analytics designed around research on how people perceive risk. Planned and not built: fsync / group commit for the log, compaction throttled by queue depth, and the kernel- and CPU-level work listed under limitations.";

export const OBJECTIVE =
  "Keep latency on the matching path predictable, make every result explainable from the code, and present risk and return in a way that helps people decide better. Every performance claim must be backed by a measurement against a baseline; the first benchmark results are in docs/BENCHMARKS.md.";

export const THEMES: { title: string; text: string; status: Status }[] = [
  { title: "Concurrency", text: "Lock-free MPSC ingestion with hazard-pointer memory reclamation.", status: "implemented" },
  { title: "Market microstructure", text: "Limit order books for 30 symbols with price-time priority, cancels and risk checks, one matching thread.", status: "implemented" },
  { title: "Observability", text: "The engine's stats (orders/s, queue depth, book depth, latency histogram) are polled by exchange-api and pushed to the browser every second.", status: "implemented" },
  { title: "Storage and recovery", text: "WAL with replay recovery and an LSM-tree trade database are built and tested. Missing: fsync / group commit, compaction throttled by queue depth, snapshots.", status: "partial" },
  { title: "Tail latency", text: "p50 / p99 from a 16-bucket power-of-two histogram, plus a first benchmark against a mutex queue; no p99.99.", status: "partial" },
  { title: "Behaviour-aware UX", text: "Daily / 30 days / 1 year windows, volatility-scaled axis, scenario preview before an order, return beside the worst fall. Comparison with a benchmark index is planned.", status: "partial" },
];

// ---- 02 Problem statement ----------------------------------------------------------------------------

export type Problem = { title: string; text: string; today: string; status: Status };

export const SYSTEM_PROBLEMS: Problem[] = [
  {
    title: "Blocking and synchronization overhead",
    text: "Mutex-based queues make threads wait for each other; a thread delayed while holding a lock stalls everyone.",
    today: "Order ingestion uses a lock-free queue, but connection threads take one ingress lock to assign the sequence number, write the log and acknowledge. The benchmark shows the lock-free queue did not beat a mutex queue on raw throughput (section 07).",
    status: "partial",
  },
  {
    title: "Unpredictable latency on the critical path",
    text: "Averages hide the rare slow orders (the tail) that dominate what users experience.",
    today: "p50 and p99 are reported by the engine (16-bucket histogram), and the benchmark reports P50 and P99 for the queue and the order book against baselines. No p99.99 yet.",
    status: "partial",
  },
  {
    title: "Copying and serialization between components",
    text: "Orders converted and copied between queue, engine and log waste CPU and pollute caches.",
    today: "Orders are fixed-size structs, but they are copied into a heap node per enqueue, and the WAL frame is its own binary format.",
    status: "planned",
  },
  {
    title: "Cache misses from pointer-heavy structures",
    text: "Tree- and list-based order books chase pointers on the hottest code path.",
    today: "A cache-aligned dense-array book exists next to the std::map book and gives the same trades; in the benchmark it ran 14.82 vs 10.12 M ops/s. The server still uses the map book.",
    status: "partial",
  },
  {
    title: "Flush and compaction interference",
    text: "Background merging in LSM stores causes latency spikes on the write path (the compaction wall).",
    today: "The storage engine has one size-tiered compaction. Its effect on matching latency is not measured, and activity-aware (queue-depth) throttling is designed, not built.",
    status: "partial",
  },
  {
    title: "Consistent recovery after failure",
    text: "After a crash, in-memory state and stored state can disagree, so recovery is not exact.",
    today: "Every accepted input is logged before it is acknowledged, and replay rebuilds the exact book (the state hash matched after kill -9). The log is not fsynced, so a power cut is not covered.",
    status: "partial",
  },
  {
    title: "OS scheduling and network-stack jitter",
    text: "The scheduler, the kernel network stack and the page cache add jitter to P99 and P99.99.",
    today: "The matching thread is pinned to one core (the measured difference is inside the run-to-run spread on this virtual machine). Orders still arrive over a local TCP socket (127.0.0.1:9100), not a real network; io_uring and XDP are future work.",
    status: "partial",
  },
];

export const BEHAVIOUR_PROBLEMS: Problem[] = [
  {
    title: "Myopic loss aversion",
    text: "Checking returns too often shows many small dips; losses feel stronger than gains, which drives panic selling.",
    today: "The market panel has Daily / 30 days / 1 year evaluation windows, and the Journey view shows one stock over its ranges (1D to 1Y) with the biggest fall and rise.",
    status: "partial",
  },
  {
    title: "Chart scaling distorts perceived risk",
    text: "A narrow or linear Y-axis can make small moves look like crashes, or decades of growth look flat.",
    today: "The Y-axis is scaled to the volatility of the series, and Journey has a Linear / Log scale switch.",
    status: "implemented",
  },
  {
    title: "One-sided framing of gains or losses",
    text: "Showing only returns encourages greed; showing only losses discourages participation.",
    today: "The window return is shown beside the worst fall in the market panel and the order ticket, and Journey shows the biggest fall beside the biggest rise. Comparison with a benchmark index is planned.",
    status: "partial",
  },
  {
    title: "No historical risk context before a decision",
    text: "Users confirm orders without seeing how similar trades have played out historically.",
    today: "The order ticket shows how similar positions ended in past periods (a spread of outcomes and the share that lost money) before the order is confirmed.",
    status: "implemented",
  },
];

export const CENTRAL_PROBLEM =
  "Build an exchange that keeps predictable, low tail latency on the critical path, recovers exactly after failure, and presents risk and return in a way that helps users decide better.";

// ---- 03 Existing work --------------------------------------------------------------------------------

export type ResearchArea = {
  topic: string;
  problem: string;
  finding: string;
  relevance: string;
  decision: string;
  gap: string;
  status: Status;
  papers: string[]; // slugs in ../research
  pdfOnly?: string[]; // works cited in the research document that have no page yet
};

export const RESEARCH_AREAS: ResearchArea[] = [
  {
    topic: "Concurrent queues and ring buffers",
    problem: "Many threads must hand work to one another without a lock becoming the bottleneck.",
    finding: "Michael and Scott give a lock-free linked-list queue built on CAS with tail helping; the LMAX Disruptor uses a pre-allocated ring buffer with a single writer.",
    relevance: "Every order enters TickForge through such a queue.",
    decision: "A Michael–Scott style linked-list queue, simplified for a single consumer.",
    gap: "No ring buffer, no back-pressure, a heap allocation per order. Measured against a mutex queue, the lock-free queue was slower on raw throughput (docs/BENCHMARKS.md).",
    status: "implemented",
    papers: ["michael-scott-1996", "disruptor-2011"],
  },
  {
    topic: "Lock-free structures and memory reclamation",
    problem: "In lock-free code a node can be freed while another thread is about to read it.",
    finding: "Hazard pointers let each thread publish the nodes it is about to use; a node is freed only when no hazard points to it.",
    relevance: "Our queue must free nodes safely without a garbage collector.",
    decision: "Hazard pointers for producers, a consumer-private retire list, seq_cst on publish and scan.",
    gap: "The retire list is scanned in batches of 64, and at most 128 threads can use the queue (the 129th aborts). The audit found and fixed four issues by reading the code, and the old bugs were never reproduced by a failing test.",
    status: "implemented",
    papers: ["hazard-pointers-2004"],
    pdfOnly: ["Fraser (2004), Practical lock-freedom", "Herlihy and Shavit, The Art of Multiprocessor Programming"],
  },
  {
    topic: "Limit order books and cache-conscious layout",
    problem: "Matching needs a clear priority rule and a data layout that is fast on the hottest path.",
    finding: "Gould et al. survey order books and note price-time priority is by far the most common rule; Chilimbi et al. show data layout drives cache behaviour.",
    relevance: "Defines how our book matches and what a faster layout would look like.",
    decision: "Price-time priority, trades at the resting order's price, the remainder rests; prices are integer cents; a cache-aligned dense-array book sits next to the std::map book.",
    gap: "The server uses the map book, because the dense book only accepts a fixed price range. Limit orders only; no market orders or modifications.",
    status: "implemented",
    papers: ["gould-2013-limit-order-books"],
    pdfOnly: ["Chilimbi, Davidson and Larus (1999), Cache-conscious structure definition"],
  },
  {
    topic: "LSM trees, flushing and compaction",
    problem: "Write-heavy stores must turn random writes into sequential ones without stalling the writer.",
    finding: "The LSM-tree buffers writes in memory and merges sorted runs on disk; SILK studies the latency spikes compaction causes; Monkey and Dostoevsky tune filters and merge policy.",
    relevance: "The trade store, and the risk that compaction hurts matching latency.",
    decision: "Built: a MemTable (BTreeMap), binary SSTables with a sparse index, a Bloom filter and a CRC-32 footer, and one size-tiered compaction. Planned: an atomic MemTable swap and compaction throttled by queue depth.",
    gap: "get_trade scans a table's data when the filter says maybe (no per-table id index); no Rust-side benchmarks; compaction's effect on latency is not measured.",
    status: "partial",
    papers: ["oneil-1996-lsm-tree", "silk-2019", "bloom-1970"],
    pdfOnly: ["Luo and Carey (2020), LSM-based storage techniques: a survey", "Dayan and Idreos (2018), Dostoevsky", "Dayan, Athanassoulis and Idreos (2017), Monkey"],
  },
  {
    topic: "Tail latency",
    problem: "Rare slow responses dominate user experience, and averages hide them.",
    finding: "Dean and Barroso show how variability is amplified at scale and argue for tail-tolerant design; Budish et al. explain why speed matters in electronic markets.",
    relevance: "Why TickForge reports percentiles and a histogram instead of an average.",
    decision: "A latency histogram with p50 and p99 in the stats stream, and a benchmark that reports P50 and P99.",
    gap: "Power-of-two buckets only give upper bounds; no p99.9 / p99.99; the benchmarks ran on one machine, and the queue and book benchmarks do not pin threads.",
    status: "partial",
    papers: ["dean-barroso-2013-tail-at-scale"],
    pdfOnly: ["Budish, Cramton and Shim (2015), The high-frequency trading arms race"],
  },
  {
    topic: "Logging and deterministic recovery",
    problem: "After a crash, memory and storage must be brought back to exactly the same state.",
    finding: "The state-machine approach: replicas that apply the same inputs in the same order reach the same state.",
    relevance: "Our matcher is a single thread, so replaying logged inputs in order should rebuild the exact book.",
    decision: "Sequence-numbered inputs written to a CRC-protected WAL before the ack, replay through the same matching code, and a state-hash check. Snapshots are planned.",
    gap: "No snapshots, so recovery replays the whole log. One write() per frame survives a process kill but not a power cut (no fsync / group commit).",
    status: "partial",
    papers: ["schneider-1990-state-machine"],
    pdfOnly: ["Ongaro and Ousterhout (2014), Raft (optional, for multi-node)"],
  },
  {
    topic: "Behavioural finance and risk visualization",
    problem: "How often and how risk is shown changes how much risk people take.",
    finding: "Benartzi and Thaler link frequent evaluation with loss aversion; Kaufmann, Weber and Haisley show presentation formats change risk-taking and understanding.",
    relevance: "Shapes the Journey view and the order-page features.",
    decision: "Daily / 30 days / 1 year evaluation windows, a volatility-scaled axis, falls shown beside gains, and a scenario preview before an order.",
    gap: "No user study; the evaluation windows apply to a stock's price history, not to a user's own P&L; no benchmark-index comparison yet.",
    status: "partial",
    papers: ["benartzi-thaler-1995-myopic-loss-aversion", "kaufmann-2013-graphical-displays"],
    pdfOnly: [
      "Kahneman and Tversky (1979), Prospect theory",
      "Thaler, Tversky, Kahneman and Schwartz (1997), myopia experiment",
      "Barber and Odean (2000), Trading is hazardous to your wealth",
      "De Bondt and Thaler (1985), Does the stock market overreact?",
    ],
  },
];

export const RESEARCH_GAP = [
  "None of the techniques above is new, and TickForge does not claim to have invented lock-free queues, LSM-trees or replay recovery. Industry and open-source systems already use core pinning, kernel bypass, io_uring, throttled compaction and deterministic replay.",
  "The defensible contribution is integration plus evidence: one transparent, from-scratch exchange stack where each technique can be switched on and measured against a baseline, paired with a user interface designed around documented behavioural effects.",
  "Today the integration covers ingestion, matching, the write-ahead log, trade storage and observation. The evidence part has started (docs/BENCHMARKS.md compares the queues and the books on one machine), but the lock-free queue did not beat the mutex queue on raw throughput, so the contribution is not yet demonstrated.",
];
