// Content for the "how'z that!" research page (/howz-that).
//
// Sources of truth: the team's research document "TickForge: Problem Statement, Differentiators and
// Research Foundation" (the PDF) and the code in this repository. Every status below was checked against the
// code on 18 Oct 2026. Rule: nothing is "implemented" just because the PDF or the roadmap mentions it, and no
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
  "TickForge is a small exchange built to study what happens on the critical path of order matching. Producer threads submit buy and sell orders through a lock-free multi-producer / single-consumer queue; one matching thread applies price-time priority on a limit order book and emits trades; a telemetry driver streams throughput, queue depth, book depth and a latency histogram to a web dashboard. A separate Python service serves real stock histories from Yahoo Finance, with long-horizon analytics designed around research on how people perceive risk. Durable storage (a write-ahead log and an LSM-tree) is designed in the research document but not built yet.";

export const OBJECTIVE =
  "Keep latency on the matching path predictable, make every result explainable from the code, and present risk and return in a way that helps people decide better. Every performance claim must eventually be backed by a measurement against a baseline.";

export const THEMES: { title: string; text: string; status: Status }[] = [
  { title: "Concurrency", text: "Lock-free MPSC ingestion with hazard-pointer memory reclamation.", status: "implemented" },
  { title: "Market microstructure", text: "Limit order book with price-time priority, one matching thread.", status: "implemented" },
  { title: "Observability", text: "Telemetry every 250 ms: orders/s, queue depth, book depth, latency histogram.", status: "implemented" },
  { title: "Storage and recovery", text: "WAL, LSM-tree, compaction and replay recovery.", status: "planned" },
  { title: "Tail latency", text: "p50 / p99 from a power-of-two histogram; p99.99 and baselines still missing.", status: "partial" },
  { title: "Behaviour-aware UX", text: "Evaluation windows up to MAX, log-scale charts, falls shown beside gains.", status: "partial" },
];

// ---- 02 Problem statement ----------------------------------------------------------------------------

export type Problem = { title: string; text: string; today: string; status: Status };

export const SYSTEM_PROBLEMS: Problem[] = [
  {
    title: "Blocking and synchronization overhead",
    text: "Mutex-based queues make threads wait for each other; a thread delayed while holding a lock stalls everyone.",
    today: "Order ingestion uses a lock-free queue. The telemetry trade buffer still takes a mutex on the matching thread.",
    status: "partial",
  },
  {
    title: "Unpredictable latency on the critical path",
    text: "Averages hide the rare slow orders (the tail) that dominate what users experience.",
    today: "p50 and p99 are reported as histogram bucket bounds. No p99.99 and no baseline comparison yet.",
    status: "partial",
  },
  {
    title: "Copying and serialization between components",
    text: "Orders converted and copied between queue, engine and log waste CPU and pollute caches.",
    today: "Orders are fixed-size structs, but they are copied into a heap node per enqueue. There is no log to write to yet.",
    status: "planned",
  },
  {
    title: "Cache misses from pointer-heavy structures",
    text: "Tree- and list-based order books chase pointers on the hottest code path.",
    today: "The book is a std::map of std::deque per price level: the pointer-based baseline.",
    status: "planned",
  },
  {
    title: "Flush and compaction interference",
    text: "Background merging in LSM stores causes latency spikes on the write path (the compaction wall).",
    today: "No storage engine yet, so this does not occur yet. Activity-aware compaction is designed, not built.",
    status: "planned",
  },
  {
    title: "Consistent recovery after failure",
    text: "After a crash, in-memory state and stored state can disagree, so recovery is not exact.",
    today: "Trades live only in memory. A single deterministic matching thread is the foundation for replay, but there is no log.",
    status: "planned",
  },
  {
    title: "OS scheduling and network-stack jitter",
    text: "The scheduler, the kernel network stack and the page cache add jitter to P99 and P99.99.",
    today: "Threads are not pinned; orders arrive over a local pipe, not a network. Core pinning, io_uring and XDP are future work.",
    status: "planned",
  },
];

export const BEHAVIOUR_PROBLEMS: Problem[] = [
  {
    title: "Myopic loss aversion",
    text: "Checking returns too often shows many small dips; losses feel stronger than gains, which drives panic selling.",
    today: "The Journey view shows one stock over 1D to MAX, with calendar-year returns and recovery times of big falls.",
    status: "partial",
  },
  {
    title: "Chart scaling distorts perceived risk",
    text: "A narrow or linear Y-axis can make small moves look like crashes, or decades of growth look flat.",
    today: "Journey has a Linear / Log scale switch and opens MAX on a log scale. A volatility-based axis is planned.",
    status: "partial",
  },
  {
    title: "One-sided framing of gains or losses",
    text: "Showing only returns encourages greed; showing only losses discourages participation.",
    today: "Journey shows the biggest fall beside the biggest rise, and MAX shows total return beside the five biggest falls.",
    status: "partial",
  },
  {
    title: "No historical risk context before a decision",
    text: "Users confirm orders without seeing how similar trades have played out historically.",
    today: "The order ticket shows no risk context yet. The scenario visualizer is planned.",
    status: "planned",
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
    gap: "No ring buffer, no back-pressure, a heap allocation per order, and no throughput measurement against a mutex baseline.",
    status: "implemented",
    papers: ["michael-scott-1996", "disruptor-2011"],
  },
  {
    topic: "Lock-free structures and memory reclamation",
    problem: "In lock-free code a node can be freed while another thread is about to read it.",
    finding: "Hazard pointers let each thread publish the nodes it is about to use; a node is freed only when no hazard points to it.",
    relevance: "Our queue must free nodes safely without a garbage collector.",
    decision: "Hazard pointers for producers, a consumer-private retire list, seq_cst on publish and scan.",
    gap: "The scan is O(retired × slots); the old reclamation bug was fixed by reasoning and never reproduced in a test.",
    status: "implemented",
    papers: ["hazard-pointers-2004"],
    pdfOnly: ["Fraser (2004), Practical lock-freedom", "Herlihy and Shavit, The Art of Multiprocessor Programming"],
  },
  {
    topic: "Limit order books and cache-conscious layout",
    problem: "Matching needs a clear priority rule and a data layout that is fast on the hottest path.",
    finding: "Gould et al. survey order books and note price-time priority is by far the most common rule; Chilimbi et al. show data layout drives cache behaviour.",
    relevance: "Defines how our book matches and what a faster layout would look like.",
    decision: "Price-time priority, trades at the resting order's price, the remainder rests.",
    gap: "The book is pointer-based (std::map + std::deque), prices are doubles not integer ticks, and there is no unit test of matching.",
    status: "implemented",
    papers: ["gould-2013-limit-order-books"],
    pdfOnly: ["Chilimbi, Davidson and Larus (1999), Cache-conscious structure definition"],
  },
  {
    topic: "LSM trees, flushing and compaction",
    problem: "Write-heavy stores must turn random writes into sequential ones without stalling the writer.",
    finding: "The LSM-tree buffers writes in memory and merges sorted runs on disk; SILK studies the latency spikes compaction causes; Monkey and Dostoevsky tune filters and merge policy.",
    relevance: "The planned trade store, and the risk that compaction hurts matching latency.",
    decision: "Planned: single-writer MemTable with an atomic swap, SSTables with Bloom filters, compaction throttled by queue depth.",
    gap: "Nothing of the storage engine exists in the code yet.",
    status: "planned",
    papers: ["oneil-1996-lsm-tree", "silk-2019", "bloom-1970"],
    pdfOnly: ["Luo and Carey (2020), LSM-based storage techniques: a survey", "Dayan and Idreos (2018), Dostoevsky", "Dayan, Athanassoulis and Idreos (2017), Monkey"],
  },
  {
    topic: "Tail latency",
    problem: "Rare slow responses dominate user experience, and averages hide them.",
    finding: "Dean and Barroso show how variability is amplified at scale and argue for tail-tolerant design; Budish et al. explain why speed matters in electronic markets.",
    relevance: "Why TickForge reports percentiles and a histogram instead of an average.",
    decision: "A latency histogram with p50 and p99 in the telemetry stream.",
    gap: "Power-of-two buckets only give upper bounds; no p99.9 / p99.99; the load is rate-limited, so the numbers are not a benchmark.",
    status: "partial",
    papers: ["dean-barroso-2013-tail-at-scale"],
    pdfOnly: ["Budish, Cramton and Shim (2015), The high-frequency trading arms race"],
  },
  {
    topic: "Logging and deterministic recovery",
    problem: "After a crash, memory and storage must be brought back to exactly the same state.",
    finding: "The state-machine approach: replicas that apply the same inputs in the same order reach the same state.",
    relevance: "Our matcher is a single thread, so replaying logged inputs in order should rebuild the exact book.",
    decision: "Planned: sequence-numbered inputs, snapshots, replay, and a state-hash check.",
    gap: "No log, no snapshots, no replay test. Orders carry a seq field (today equal to the order id) but nothing records it.",
    status: "planned",
    papers: ["schneider-1990-state-machine"],
    pdfOnly: ["Ongaro and Ousterhout (2014), Raft (optional, for multi-node)"],
  },
  {
    topic: "Behavioural finance and risk visualization",
    problem: "How often and how risk is shown changes how much risk people take.",
    finding: "Benartzi and Thaler link frequent evaluation with loss aversion; Kaufmann, Weber and Haisley show presentation formats change risk-taking and understanding.",
    relevance: "Shapes the Journey view and the planned order-page features.",
    decision: "Evaluation windows from 1D to MAX, log-scale charts, falls shown beside gains.",
    gap: "No user study; the P&L evaluation toggle and the scenario visualizer need the paper-trading ledger.",
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
  "Today the integration covers ingestion, matching and observation. The evidence part (benchmarks against baselines) has not been done yet, so the contribution is not yet demonstrated.",
];
