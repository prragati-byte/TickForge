# tickforge_db

The trade database: a small LSM tree written in Rust, used from Python.
The Python API is described in `docs/CONTRACTS.md`, section 4.

```
insert_trade -> wal.log (crash safety) -> memtable (BTreeMap)
                                              | flush
                                              v
                              sst-<n>.tfs  (sorted, sparse index, Bloom filter, CRC-32)
                                              | compact (neighbours of similar size)
                                              v
                                       one bigger sst file
```

| File | Job |
|---|---|
| `src/record.rs` | the `Trade` struct and its binary form |
| `src/log.rs` | the database's own log, replayed on open |
| `src/memtable.rs` | recent trades in memory |
| `src/sstable.rs` | write, open (checks the CRC), get, range |
| `src/bloom.rs` | Bloom filter on trade ids |
| `src/database.rs` | open, insert, get, range, flush, compact |
| `src/python.rs` | the `TickForgeDB` class (built with the `python` feature) |

## Commands

```bash
cargo test                   # Rust tests (no Python needed)
maturin develop --release    # build the module into the active virtualenv
python -m unittest storage/tests/test_python.py   # Python smoke test (run from the repo root)
```
