// tickforge-db/src/wal/writer.rs
use std::ffi::CString;
use std::os::raw::c_char;
use crate::record::TradeRecord;

// Declaring foreign C interface blocks must now be explicitly marked as unsafe
unsafe extern "C" {
    fn c_wal_init(path: *const c_char, sync_on_commit: bool) -> bool;
    fn c_wal_close();
    fn c_wal_commit_records(txid: u64, records: *const *const c_char, len: usize) -> bool;
}

pub struct Wal {
    path: String,
}

impl Wal {
    /// Initializes the C++ WAL engine and creates the file path
    pub fn open(path: &str) -> std::io::Result<Self> {
        // Ensure any parent directory structures are created first
        if let Some(parent) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(parent)?;
        }

        let c_path = CString::new(path).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
        
        // Pass true to trigger the internal C++ fsync operation on every commit
        unsafe {
            if !c_wal_init(c_path.as_ptr(), true) {
                return Err(std::io::Error::new(std::io::ErrorKind::Other, "C++ WAL initialization failed"));
            }
        }

        Ok(Self {
            path: path.to_string(),
        })
    }

    /// Appends a Trade Record by converting it into a compact format and flashing it down to C++
    pub fn append(&mut self, trade: &TradeRecord) -> std::io::Result<()> {
        // Format trade metrics using your valid structural fields
        let record_str = format!(
            "ID:{},TRADER:{},PRICE:{},QTY:{},SIDE:{}",
            trade.trade_id, trade.trader_id, trade.price, trade.qty, trade.side
        );

        let c_record = CString::new(record_str.as_str())
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
        
        let pointer_array = [c_record.as_ptr()];

        unsafe {
            // Using trade_id as the C++ sequential Transaction ID (txid)
            let success = c_wal_commit_records(trade.trade_id as u64, pointer_array.as_ptr(), pointer_array.len());
            if !success {
                return Err(std::io::Error::new(std::io::ErrorKind::WriteZero, "C++ WAL commit append failed"));
            }
        }

        println!("WAL (C++ Engine): Trade {} saved securely", trade.trade_id);
        Ok(())
    }

    /// Replays logged records back into active memory vectors on system boots
    pub fn replay(&self) -> std::io::Result<Vec<TradeRecord>> {
        let trades = Vec::new(); // Removed unused mut warning
        
        // Note: To implement this completely, bind your C++ `wal_reader.cpp` functionality here.
        // Returning an empty vector for now to ensure your database engine compiles smoothly.
        
        Ok(trades)
    }
}

// Automatically tear down and close open C++ file handles when the Wal struct goes out of scope
impl Drop for Wal {
    fn drop(&mut self) {
        unsafe {
            c_wal_close();
        }
    }
}
