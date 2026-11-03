//! TickForge trade database: a small LSM tree.
//!
//! Insert path:  log (crash safety) -> memtable (sorted map) -> flush -> SSTable file.
//! Read path:    memtable, then SSTables from newest to oldest (Bloom filter first).
//! `compact()` merges neighbouring SSTables of similar size into one.
//!
//! The Python class `TickForgeDB` is in `python.rs` and only built with the
//! `python` feature (maturin does that).

mod bloom;
mod database;
mod error;
mod log;
mod memtable;
mod record;
mod sstable;

pub use bloom::Bloom;
pub use database::Database;
pub use error::DbError;
pub use record::Trade;
pub use sstable::SsTable;

#[cfg(feature = "python")]
mod python;
