//! The database's own small write-ahead log (file `wal.log` in the database
//! directory). Every insert is written here before it goes into the memtable.
//! On open the log is read back, so trades that were not yet flushed to an
//! SSTable survive a crash.
//!
//! Frame: len u32, crc32 u32, then `len` bytes holding one encoded trade.

use crate::error::DbError;
use crate::record::Trade;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;

pub struct Log {
    file: File,
}

impl Log {
    /// Open (or create) the log. Every good frame is passed to `on_trade`.
    /// A half-written frame at the end is cut off.
    pub fn open(path: &Path, mut on_trade: impl FnMut(Trade)) -> Result<Log, DbError> {
        let bytes = std::fs::read(path).unwrap_or_default();
        let mut pos = 0;
        while pos + 8 <= bytes.len() {
            let len = u32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
            let crc = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap());
            let end = pos + 8 + len;
            if end > bytes.len() || crc32fast::hash(&bytes[pos + 8..end]) != crc {
                break;
            }
            match Trade::decode(&bytes[pos + 8..end]) {
                Some((trade, _)) => on_trade(trade),
                None => break,
            }
            pos = end;
        }

        let file = OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .open(path)?;
        if (pos as u64) < bytes.len() as u64 {
            file.set_len(pos as u64)?;
        }
        Ok(Log { file })
    }

    /// Append one trade. It is in the operating system's hands when this
    /// returns, so it survives a crash of this process.
    pub fn append(&mut self, trade: &Trade) -> Result<(), DbError> {
        let mut payload = Vec::new();
        trade.encode(&mut payload);
        let mut frame = Vec::with_capacity(8 + payload.len());
        frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        frame.extend_from_slice(&crc32fast::hash(&payload).to_le_bytes());
        frame.extend_from_slice(&payload);
        self.file.write_all(&frame)?; // one write call per frame
        Ok(())
    }

    /// Empty the log. Called after the memtable was flushed to an SSTable.
    pub fn reset(&mut self) -> Result<(), DbError> {
        self.file.set_len(0)?;
        Ok(())
    }
}
