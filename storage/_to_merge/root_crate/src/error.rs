// TickForge ke saare error types ek jagah — caller ko String match nahi karni padegi.
// DbError ek proper enum hai jisme teen variants hain:
//   Io      — OS/disk level ki errors (automatically std::io::Error se convert hoti hain)
//   Corrupt — WAL ya SSTable mein data galat mila (CRC mismatch, bad JSON, etc.)
//   Validation — insert se pehle trade invalid hai (price=0, quantity=0, empty symbol, etc.)

use std::fmt;

#[derive(Debug)]
pub enum DbError {
    /// File read/write/seek failures — OS se aai errors
    Io(std::io::Error),
    /// Data on disk corrupt hai (CRC mismatch, truncated record, bad JSON)
    Corrupt(String),
    /// Trade record invalid hai (price, quantity, ya symbol check fail hua)
    Validation(String),
}

// std::io::Error ko automatically DbError::Io mein convert karo
// Isse ? operator WAL/SSTable functions mein seedha kaam karta hai
impl From<std::io::Error> for DbError {
    fn from(e: std::io::Error) -> Self {
        DbError::Io(e)
    }
}

// User-readable error messages
impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DbError::Io(e) => write!(f, "I/O error: {e}"),
            DbError::Corrupt(msg) => write!(f, "Data corruption detected: {msg}"),
            DbError::Validation(msg) => write!(f, "Validation failed: {msg}"),
        }
    }
}

// std::error::Error implement karo taaki Box<dyn std::error::Error> mein wrap ho sake
impl std::error::Error for DbError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            DbError::Io(e) => Some(e),
            _ => None,
        }
    }
}
