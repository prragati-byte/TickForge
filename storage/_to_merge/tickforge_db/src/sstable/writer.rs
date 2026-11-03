//this code is a storage mechanism designed to permanently save trade records into a physical file on your disk
use crate::record::TradeRecord;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;

pub fn write_sstable(path: &str, trades: &[TradeRecord]) -> std::io::Result<()> {
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent)?;
    }
    let file = File::create(path)?;  
    let mut writer = BufWriter::new(file);

    for trade in trades {
        let json = serde_json::to_string(trade).map_err(std::io::Error::other)?; // Rust into JSON
        writeln!(writer, "{json}")?;
    }

    writer.flush()?;
    println!("SSTABLE: {} records written to {}", trades.len(), path);

    Ok(())
}
