use std::fmt;
use std::io;

/// Errors from the database. In Python, `Invalid` becomes `ValueError`
/// and `Io` becomes `OSError`.
#[derive(Debug)]
pub enum DbError {
    /// A file could not be read or written, or a file is corrupt.
    Io(io::Error),
    /// The caller passed a bad value.
    Invalid(String),
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DbError::Io(e) => write!(f, "{e}"),
            DbError::Invalid(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for DbError {}

impl From<io::Error> for DbError {
    fn from(e: io::Error) -> Self {
        DbError::Io(e)
    }
}

/// Shortcut for "this file is damaged".
pub fn corrupt(what: &str) -> DbError {
    DbError::Io(io::Error::new(io::ErrorKind::InvalidData, what.to_string()))
}
