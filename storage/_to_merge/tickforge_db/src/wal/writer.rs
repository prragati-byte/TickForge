use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use crate::record::TradeRecord;

pub struct Wal {
    file: File,
    path: String,
}

impl Wal {
    pub fn open(path: &str) -> std::io::Result<Self> {
        if let Some(parent) = Path::new(path).parent() {
            fs::create_dir_all(parent)?;
        }

        let file = OpenOptions::new().create(true).append(true).open(path)?;

        Ok(Self {
            file,
            path: path.to_string(),
        })
    }

    pub fn append(&mut self, trade: &TradeRecord) -> std::io::Result<()> {
        let json = serde_json::to_string(trade).map_err(std::io::Error::other)?;

        writeln!(self.file, "{json}")?;

        // OS ko file data sync karne ki request.
        self.file.sync_data()?;

        println!("WAL: Trade {} saved", trade.trade_id);
        Ok(())
    }

    pub fn replay(&self) -> std::io::Result<Vec<TradeRecord>> {
        let file = File::open(&self.path)?;
        let reader = BufReader::new(file);
        let mut trades = Vec::new();

        for line in reader.lines() {
            let line = line?;

            if line.trim().is_empty() {
                continue;
            }

            let trade: TradeRecord = serde_json::from_str(&line).map_err(std::io::Error::other)?;

            trades.push(trade);
        }

        Ok(trades)
    }
}
