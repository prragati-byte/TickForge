// TickForge DB — Criterion Benchmarks
//
// Run: cargo bench
//
// Covers:
//   bench_wal_append        → WAL throughput (durability overhead)
//   bench_memtable_insert   → pure MemTable write speed
//   bench_memtable_get      → MemTable point lookup
//   bench_bloom_insert      → Bloom filter insert speed
//   bench_bloom_lookup      → Bloom filter lookup speed (no disk)
//   bench_sstable_write     → SSTable write throughput
//   bench_sstable_read      → SSTable scan throughput
//   bench_db_insert         → Full DB insert (WAL + MemTable)
//   bench_matching_engine   → Order matching throughput

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use tickforge_db::bloom::BloomFilter;
use tickforge_db::database::Database;
use tickforge_db::exchange::MatchingEngine;
use tickforge_db::memtable::MemTable;
use tickforge_db::record::TradeRecord;
use tickforge_db::sstable::{read_all_trades, write_sstable};

// ── Helper ───────────────────────────────────────────────────────────────────

fn make_trade(id: u64) -> TradeRecord {
    TradeRecord {
        trade_id:    id,
        symbol:      "BENCH".to_string(),
        price_paise: 100_000 + id,
        quantity:    id % 100 + 1,
        timestamp:   1_700_000_000 + id,
        seq_num:     id,
        deleted:     false,
    }
}

fn trades_batch(n: usize) -> Vec<TradeRecord> {
    (1..=n as u64).map(make_trade).collect()
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. WAL Append
// ═══════════════════════════════════════════════════════════════════════════

fn bench_wal_append(c: &mut Criterion) {
    let dir  = tempfile::tempdir().unwrap();
    let path = dir.path().join("bench_wal.log").to_string_lossy().to_string();

    let mut group = c.benchmark_group("wal");
    group.throughput(Throughput::Elements(1));

    group.bench_function("append_single", |b| {
        let mut wal = tickforge_db::wal::Wal::open(&path).unwrap();
        let trade   = make_trade(1);
        b.iter(|| {
            wal.append(black_box(&trade)).unwrap();
        });
    });

    group.finish();
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. MemTable
// ═══════════════════════════════════════════════════════════════════════════

fn bench_memtable(c: &mut Criterion) {
    let mut group = c.benchmark_group("memtable");

    group.bench_function("insert", |b| {
        let mut mt = MemTable::new();
        let mut id = 0u64;
        b.iter(|| {
            id += 1;
            mt.insert(black_box(make_trade(id)));
        });
    });

    group.bench_function("get_hit", |b| {
        let mut mt = MemTable::new();
        for i in 1..=10_000u64 { mt.insert(make_trade(i)); }
        b.iter(|| {
            let _ = black_box(mt.get(5000));
        });
    });

    group.bench_function("get_miss", |b| {
        let mut mt = MemTable::new();
        for i in 1..=10_000u64 { mt.insert(make_trade(i)); }
        b.iter(|| {
            let _ = black_box(mt.get(99_999_999));
        });
    });

    group.finish();
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Bloom Filter
// ═══════════════════════════════════════════════════════════════════════════

fn bench_bloom(c: &mut Criterion) {
    let mut group = c.benchmark_group("bloom");

    group.bench_function("insert", |b| {
        let mut bf = BloomFilter::with_capacity(10_000);
        let mut id = 0u64;
        b.iter(|| {
            id += 1;
            bf.insert(black_box(id));
        });
    });

    group.bench_function("lookup_hit", |b| {
        let mut bf = BloomFilter::with_capacity(10_000);
        for i in 1..=10_000u64 { bf.insert(i); }
        b.iter(|| { let _ = black_box(bf.might_contain(5000)); });
    });

    group.bench_function("lookup_miss", |b| {
        let mut bf = BloomFilter::with_capacity(10_000);
        for i in 1..=10_000u64 { bf.insert(i); }
        b.iter(|| { let _ = black_box(bf.might_contain(99_999_999)); });
    });

    group.finish();
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. SSTable Write + Read
// ═══════════════════════════════════════════════════════════════════════════

fn bench_sstable(c: &mut Criterion) {
    let dir   = tempfile::tempdir().unwrap();
    let mut group = c.benchmark_group("sstable");

    for n in [100usize, 1_000, 10_000] {
        let trades = trades_batch(n);
        group.throughput(Throughput::Elements(n as u64));

        group.bench_with_input(BenchmarkId::new("write", n), &trades, |b, trades| {
            let path = dir.path().join(format!("bench_{n}.sst"))
                .to_string_lossy().to_string();
            b.iter(|| { write_sstable(black_box(&path), black_box(trades)).unwrap(); });
        });

        let path = dir.path().join(format!("bench_read_{n}.sst"))
            .to_string_lossy().to_string();
        write_sstable(&path, &trades_batch(n)).unwrap();
        group.bench_with_input(BenchmarkId::new("read", n), &path, |b, path| {
            b.iter(|| { let _ = black_box(read_all_trades(path).unwrap()); });
        });
    }

    group.finish();
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Full DB Insert
// ═══════════════════════════════════════════════════════════════════════════

fn bench_db_insert(c: &mut Criterion) {
    let mut group = c.benchmark_group("database");
    group.throughput(Throughput::Elements(1));

    group.bench_function("insert_single", |b| {
        let dir  = tempfile::tempdir().unwrap();
        let path = dir.path().join("bench_db.log").to_string_lossy().to_string();
        let mut db = Database::open(&path).unwrap();
        let mut id = 0u64;
        b.iter(|| {
            id += 1;
            db.insert_trade(black_box(make_trade(id))).unwrap();
        });
    });

    for n in [100usize, 1_000, 10_000] {
        group.throughput(Throughput::Elements(n as u64));
        group.bench_with_input(BenchmarkId::new("batch_insert", n), &n, |b, &n| {
            let dir  = tempfile::tempdir().unwrap();
            let path = dir.path().join("bench_batch.log").to_string_lossy().to_string();
            b.iter(|| {
                let mut db = Database::open(&path).unwrap();
                for id in 1..=n as u64 {
                    db.insert_trade(make_trade(id)).unwrap();
                }
            });
        });
    }

    group.finish();
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Matching Engine
// ═══════════════════════════════════════════════════════════════════════════

fn bench_matching_engine(c: &mut Criterion) {
    let mut group = c.benchmark_group("matching_engine");

    // Throughput: alternating buy/sell (fully matched, no book buildup)
    group.bench_function("alternating_limit_orders", |b| {
        let mut engine = MatchingEngine::new();
        let ts = 1_700_000_000u64;
        b.iter(|| {
            let ts = black_box(ts);
            let _  = engine.limit_sell("BENCH", 100_000, 1, ts).unwrap();
            let _  = engine.limit_buy("BENCH",  100_000, 1, ts + 1).unwrap();
        });
    });

    // Market buy against pre-seeded book
    group.bench_function("market_buy_preseeded", |b| {
        let mut engine = MatchingEngine::new();
        // Pre-seed with 1000 sell orders
        for i in 0..1000u64 {
            engine.limit_sell("X", 100_000 + i, 1, i).unwrap();
        }
        b.iter(|| {
            let _ = engine.market_buy(black_box("X"), black_box(1), 9_999_999).unwrap();
            // Reseed to keep book non-empty
            engine.limit_sell("X", 99_000, 1, 0).unwrap();
        });
    });

    // Order submission throughput (n orders, building the book)
    for n in [100usize, 1_000, 10_000] {
        group.throughput(Throughput::Elements(n as u64));
        group.bench_with_input(BenchmarkId::new("limit_sell_buildup", n), &n, |b, &n| {
            b.iter(|| {
                let mut engine = MatchingEngine::new();
                for i in 0..n as u64 {
                    engine.limit_sell("Y", 100_000 + i, 1, i).unwrap();
                }
            });
        });
    }

    group.finish();
}

// ═══════════════════════════════════════════════════════════════════════════
// Criterion entry point
// ═══════════════════════════════════════════════════════════════════════════

criterion_group!(
    benches,
    bench_wal_append,
    bench_memtable,
    bench_bloom,
    bench_sstable,
    bench_db_insert,
    bench_matching_engine,
);
criterion_main!(benches);
