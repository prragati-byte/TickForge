// tickforge-db/src/lib.rs
pub mod database;
pub mod memtable;
pub mod record;
pub mod sstable;
pub mod triggers;
pub mod wal;

use pyo3::prelude::*;
use crate::database::TickForgeDatabase;
use crate::record::TradeRecord;

#[pyclass]
pub struct PyTradingEngine {
    db: TickForgeDatabase,
}

#[pymethods]
impl PyTradingEngine {
    #[new]
    fn new(wal_path: &str) -> PyResult<Self> {
        let db = TickForgeDatabase::new(wal_path); // Your engine sets up LSM + C++ WAL here
        Ok(PyTradingEngine { db })
    }

    /// Exposes order execution to FastAPI
    fn execute_order(&mut self, trade_id: u64, trader_id: u32, price: u64, qty: u64, side: String) -> PyResult<bool> {
        let record = TradeRecord {
            trade_id,
            trader_id,
            price,
            qty,
            side,
        };

        // Call your internal Rust LSM DB engine append logic
        match self.db.append_and_match(&record) {
            Ok(_) => Ok(true),
            // FIXED: Replaced invalid PyPyErr with PyRuntimeError
            Err(e) => Err(pyo3::exceptions::PyRuntimeError::new_err(e.to_string())),
        }
    }
}

/// Defines the native Python module
#[pymodule]
fn tickforge_db(_py: Python, m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyTradingEngine>()?;
    Ok(())
}
