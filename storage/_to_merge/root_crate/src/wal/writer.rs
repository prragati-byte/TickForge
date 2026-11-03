// WAL (Write-Ahead Log) — TickForge ka durability backbone.
//
// Record format on disk (binary framing):
//   [payload_len: u32 LE] [crc32: u32 LE] [payload bytes (JSON)]
//
// Kyun yeh format?
//   1. Fixed 8-byte header se hum jaante hain kitna padha jaayega.
//   2. CRC32 se pata chalta hai agar bit flip ya partial write hua.
//   3. Poora record ek hi write_all() call mein jaata hai — split nahi hota.
//   4. Replay mein tail par torn record mila to hum ruk jaate hain aur
//      file us point tak truncate karte hain (crash recovery).

use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;

use crate::error::DbError;
use crate::record::TradeRecord;

pub struct Wal {
    file: File,
    path: String,
}

impl Wal {
    /// WAL file open karo (ya create karo agar exist nahi karti).
    /// Torn tail automatically truncate ho jaata hai.
    pub fn open(path: &str) -> Result<Self, DbError> {
        if let Some(parent) = Path::new(path).parent() {
            fs::create_dir_all(parent)?;
        }

        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(false)
            .write(true)
            .open(path)?;

        // Torn tail recover karo: valid bytes tak truncate karo
        let valid_len = Self::find_valid_length(&mut file, path)?;
        file.set_len(valid_len)?;
        // Cursor ko end par set karo taaki append sahi jagah ho
        file.seek(SeekFrom::End(0))?;

        Ok(Self {
            file,
            path: path.to_string(),
        })
    }

    /// Ek trade record WAL mein append karo.
    /// Single write_all() + sync_data() — split write ka darr nahi.
    pub fn append(&mut self, trade: &TradeRecord) -> Result<(), DbError> {
        let payload = serde_json::to_vec(trade)
            .map_err(|e| DbError::Corrupt(format!("Serialize failed: {e}")))?;

        let crc = crc32fast::hash(&payload);
        let len = payload.len() as u32;

        // Poora record ek buffer mein pack karo: [len][crc][payload]
        let mut buf = Vec::with_capacity(8 + payload.len());
        buf.extend_from_slice(&len.to_le_bytes());
        buf.extend_from_slice(&crc.to_le_bytes());
        buf.extend_from_slice(&payload);

        // Ek hi syscall — crash ke beech mein split nahi hoga
        self.file.write_all(&buf)?;
        // OS buffer → disk
        self.file.sync_data()?;
        Ok(())
    }

    /// WAL se saare valid records wapas laao (startup par call hota hai).
    /// Corrupt ya torn record milte hi ruk jaao — uske baad wala sab discard.
    pub fn replay(&mut self) -> Result<Vec<TradeRecord>, DbError> {
        let data = fs::read(&self.path)?;
        let (trades, _valid_len) = Self::parse_records(&data)?;
        Ok(trades)
    }

    /// WAL file ko truncate karo (MemTable flush ke baad call karo).
    /// Isse WAL hamesha badhta nahi rehta aur restart par replay fast hoti hai.
    pub fn truncate(&mut self) -> Result<(), DbError> {
        self.file.set_len(0)?;
        self.file.seek(SeekFrom::Start(0))?;
        self.file.sync_data()?;
        Ok(())
    }

    // ─── Private helpers ────────────────────────────────────────────────────

    /// File mein kitne bytes valid hain woh count karo.
    /// Torn tail ya CRC mismatch milte hi rok do.
    fn find_valid_length(file: &mut File, path: &str) -> Result<u64, DbError> {
        let data = {
            use std::io::Read;
            let mut buf = Vec::new();
            file.seek(SeekFrom::Start(0))?;
            file.read_to_end(&mut buf)?;
            buf
        };
        let (_trades, valid_len) = Self::parse_records(&data)?;
        // Cursor reset (caller seek karega)
        let _ = path; // path sirf context ke liye pass tha
        Ok(valid_len)
    }

    /// Binary data parse karo, (records, valid_bytes) return karo.
    fn parse_records(data: &[u8]) -> Result<(Vec<TradeRecord>, u64), DbError> {
        let mut pos = 0usize;
        let mut trades = Vec::new();

        while pos + 8 <= data.len() {
            // Header: [len u32][crc u32]
            let payload_len =
                u32::from_le_bytes(data[pos..pos + 4].try_into().unwrap()) as usize;
            let stored_crc =
                u32::from_le_bytes(data[pos + 4..pos + 8].try_into().unwrap());

            let payload_start = pos + 8;
            let payload_end = payload_start + payload_len;

            // Torn write: record poora nahi likha gaya tha
            if payload_end > data.len() {
                break;
            }

            let payload = &data[payload_start..payload_end];

            // CRC mismatch: bit flip ya partial overwrite
            let actual_crc = crc32fast::hash(payload);
            if actual_crc != stored_crc {
                break;
            }

            // JSON parse
            match serde_json::from_slice::<TradeRecord>(payload) {
                Ok(trade) => trades.push(trade),
                Err(_) => break, // should not happen if CRC passed
            }

            pos = payload_end;
        }

        Ok((trades, pos as u64))
    }
}
