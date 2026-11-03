//! Python binding: `from tickforge_db import TickForgeDB` (see docs/CONTRACTS.md, section 4).
//!
//! Errors: bad arguments raise ValueError, file problems raise OSError.

use crate::{Database, DbError, Trade};
use pyo3::exceptions::{PyOSError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};
use std::path::Path;

fn to_py_err(e: DbError) -> PyErr {
    match e {
        DbError::Io(e) => PyOSError::new_err(e.to_string()),
        DbError::Invalid(msg) => PyValueError::new_err(msg),
    }
}

/// Python ints arrive as i64 so that a negative value gives a clear ValueError.
fn non_negative(name: &str, value: i64) -> PyResult<u64> {
    u64::try_from(value).map_err(|_| PyValueError::new_err(format!("{name} must not be negative")))
}

fn trade_to_dict<'py>(py: Python<'py>, t: &Trade) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("trade_id", t.trade_id)?;
    d.set_item("symbol", &t.symbol)?;
    d.set_item("price_cents", t.price_cents)?;
    d.set_item("quantity", t.quantity)?;
    d.set_item("buy_order_id", t.buy_order_id)?;
    d.set_item("sell_order_id", t.sell_order_id)?;
    d.set_item("buyer_id", t.buyer_id)?;
    d.set_item("seller_id", t.seller_id)?;
    d.set_item("timestamp_ms", t.timestamp_ms)?;
    Ok(d)
}

#[pyclass(name = "TickForgeDB")]
struct PyTickForgeDB {
    db: Database,
}

#[pymethods]
impl PyTickForgeDB {
    #[new]
    fn new(path: &str) -> PyResult<Self> {
        let db = Database::open(Path::new(path)).map_err(to_py_err)?;
        Ok(PyTickForgeDB { db })
    }

    #[pyo3(signature = (trade_id, symbol, price_cents, quantity, buy_order_id, sell_order_id, buyer_id, seller_id, timestamp_ms))]
    #[allow(clippy::too_many_arguments)]
    fn insert_trade(
        &mut self,
        trade_id: i64,
        symbol: &str,
        price_cents: i64,
        quantity: i64,
        buy_order_id: i64,
        sell_order_id: i64,
        buyer_id: i64,
        seller_id: i64,
        timestamp_ms: i64,
    ) -> PyResult<()> {
        let trade = Trade {
            trade_id: non_negative("trade_id", trade_id)?,
            symbol: symbol.to_string(),
            price_cents,
            quantity: non_negative("quantity", quantity)?,
            buy_order_id: non_negative("buy_order_id", buy_order_id)?,
            sell_order_id: non_negative("sell_order_id", sell_order_id)?,
            buyer_id: non_negative("buyer_id", buyer_id)?,
            seller_id: non_negative("seller_id", seller_id)?,
            timestamp_ms: non_negative("timestamp_ms", timestamp_ms)?,
        };
        self.db.insert_trade(trade).map_err(to_py_err)
    }

    fn get_trade<'py>(
        &self,
        py: Python<'py>,
        trade_id: i64,
    ) -> PyResult<Option<Bound<'py, PyDict>>> {
        let id = non_negative("trade_id", trade_id)?;
        match self.db.get_trade(id).map_err(to_py_err)? {
            Some(t) => Ok(Some(trade_to_dict(py, &t)?)),
            None => Ok(None),
        }
    }

    #[pyo3(signature = (start_ms, end_ms, symbol=None))]
    fn range<'py>(
        &self,
        py: Python<'py>,
        start_ms: i64,
        end_ms: i64,
        symbol: Option<&str>,
    ) -> PyResult<Bound<'py, PyList>> {
        let start = non_negative("start_ms", start_ms)?;
        let end = non_negative("end_ms", end_ms)?;
        let trades = self.db.range(start, end, symbol).map_err(to_py_err)?;
        let list = PyList::empty(py);
        for t in &trades {
            list.append(trade_to_dict(py, t)?)?;
        }
        Ok(list)
    }

    fn count(&self) -> u64 {
        self.db.count()
    }

    fn flush(&mut self) -> PyResult<()> {
        self.db.flush().map_err(to_py_err)
    }

    fn compact(&mut self) -> PyResult<usize> {
        self.db.compact().map_err(to_py_err)
    }
}

#[pymodule]
fn tickforge_db(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyTickForgeDB>()?;
    Ok(())
}
