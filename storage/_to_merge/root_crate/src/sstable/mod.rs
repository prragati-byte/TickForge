mod writer;
mod reader;

pub use writer::write_sstable;
pub use reader::{
    read_all_trades,
    read_metadata,
    find_trade,
    SstableMetadata,
    // backward-compat aliases
    read_sstable,
    find_trade_in_sstable,
};
