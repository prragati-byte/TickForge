//! SSTable: an immutable file of trades sorted by (timestamp_ms, trade_id).
//!
//! ```text
//! data    trade records, one after another (see record.rs)
//! bloom   Bloom filter over the trade ids
//! index   every 64th record: timestamp u64, trade_id u64, file offset u64
//! footer  magic "TFSST001", record count, bloom offset, index offset,
//!         index entries, min trade_id, max trade_id (u64 each), then CRC-32
//!         of every byte before the CRC (u32)
//! ```
//! All numbers are little-endian. `open` checks the CRC, so a damaged file is
//! refused instead of returning wrong data.

use crate::bloom::Bloom;
use crate::error::{corrupt, DbError};
use crate::record::Trade;
use std::fs::{self, File};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// How SSTable files reach the disk. Both give identical files.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum IoBackend {
    /// `write` and `fsync`, through the page cache.
    #[default]
    Standard,
    /// Batched and asynchronous through io_uring, O_DIRECT where the file system allows it.
    /// Linux only.
    Uring,
}

impl IoBackend {
    /// Can this backend be used here? For `Uring` this really creates a ring, because
    /// containers and sysctl can block io_uring on a kernel that was built with it.
    pub fn check(self) -> Result<(), DbError> {
        match self {
            IoBackend::Standard => Ok(()),
            #[cfg(target_os = "linux")]
            IoBackend::Uring => crate::uring::supported().map_err(DbError::from),
            #[cfg(not(target_os = "linux"))]
            IoBackend::Uring => Err(unsupported().into()),
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn unsupported() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Unsupported, "io_uring only exists on Linux")
}

const MAGIC: &[u8; 8] = b"TFSST001";
const FOOTER_LEN: usize = 8 + 6 * 8 + 4;
const INDEX_EVERY: usize = 64;

#[derive(Debug)]
pub struct SsTable {
    path: PathBuf,
    count: u64,
    data_len: u64,
    min_id: u64,
    max_id: u64,
    bloom: Bloom,
    /// (timestamp_ms, trade_id, offset) of every 64th record.
    index: Vec<(u64, u64, u64)>,
    file_size: u64,
}

fn read_u64(buf: &[u8], pos: usize) -> u64 {
    u64::from_le_bytes(buf[pos..pos + 8].try_into().unwrap())
}

impl SsTable {
    /// Write `trades` (already sorted by (timestamp_ms, trade_id), ids unique)
    /// to `path`. The file appears atomically: written to `path.tmp`, then renamed.
    pub fn write(path: &Path, trades: &[Trade]) -> Result<(), DbError> {
        Self::write_with(path, trades, IoBackend::Standard)
    }

    /// The same, choosing how the bytes reach the disk.
    pub fn write_with(path: &Path, trades: &[Trade], io: IoBackend) -> Result<(), DbError> {
        let mut buf = Vec::new();
        let mut index: Vec<(u64, u64, u64)> = Vec::new();
        let mut bloom = Bloom::with_capacity(trades.len());
        let (mut min_id, mut max_id) = (u64::MAX, 0u64);

        for (i, t) in trades.iter().enumerate() {
            if i % INDEX_EVERY == 0 {
                index.push((t.timestamp_ms, t.trade_id, buf.len() as u64));
            }
            bloom.insert(t.trade_id);
            min_id = min_id.min(t.trade_id);
            max_id = max_id.max(t.trade_id);
            t.encode(&mut buf);
        }

        let bloom_off = buf.len() as u64;
        buf.extend_from_slice(bloom.as_bytes());
        let index_off = buf.len() as u64;
        for (ts, id, off) in &index {
            buf.extend_from_slice(&ts.to_le_bytes());
            buf.extend_from_slice(&id.to_le_bytes());
            buf.extend_from_slice(&off.to_le_bytes());
        }

        buf.extend_from_slice(MAGIC);
        for n in [
            trades.len() as u64,
            bloom_off,
            index_off,
            index.len() as u64,
            min_id,
            max_id,
        ] {
            buf.extend_from_slice(&n.to_le_bytes());
        }
        let crc = crc32fast::hash(&buf);
        buf.extend_from_slice(&crc.to_le_bytes());

        let tmp = path.with_extension("tfs.tmp");
        match io {
            IoBackend::Standard => {
                let mut file = File::create(&tmp)?;
                file.write_all(&buf)?;
                file.sync_all()?;
            }
            #[cfg(target_os = "linux")]
            IoBackend::Uring => {
                crate::uring::write_file(&tmp, &buf)?;
            }
            #[cfg(not(target_os = "linux"))]
            IoBackend::Uring => return Err(unsupported().into()),
        }
        fs::rename(&tmp, path)?;
        Ok(())
    }

    /// Open a file and check it. Fails with InvalidData if it is damaged.
    pub fn open(path: &Path) -> Result<SsTable, DbError> {
        let bytes = fs::read(path)?;
        let n = bytes.len();
        if n < FOOTER_LEN {
            return Err(corrupt("SSTable is too short"));
        }
        let footer = n - FOOTER_LEN;
        if &bytes[footer..footer + 8] != MAGIC {
            return Err(corrupt("SSTable has a bad footer"));
        }
        let stored_crc = u32::from_le_bytes(bytes[n - 4..].try_into().unwrap());
        if crc32fast::hash(&bytes[..n - 4]) != stored_crc {
            return Err(corrupt("SSTable checksum does not match"));
        }

        let f = |i: usize| read_u64(&bytes, footer + 8 + i * 8);
        let (count, bloom_off, index_off, index_len) =
            (f(0), f(1) as usize, f(2) as usize, f(3) as usize);
        if bloom_off > index_off || index_off + index_len * 24 != footer {
            return Err(corrupt("SSTable footer is inconsistent"));
        }
        let bloom = Bloom::from_bytes(&bytes[bloom_off..index_off])
            .ok_or_else(|| corrupt("SSTable has no Bloom filter"))?;
        let index = (0..index_len)
            .map(|i| {
                let p = index_off + i * 24;
                (
                    read_u64(&bytes, p),
                    read_u64(&bytes, p + 8),
                    read_u64(&bytes, p + 16),
                )
            })
            .collect();

        Ok(SsTable {
            path: path.to_path_buf(),
            count,
            data_len: bloom_off as u64,
            min_id: f(4),
            max_id: f(5),
            bloom,
            index,
            file_size: n as u64,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn len(&self) -> u64 {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    pub fn file_size(&self) -> u64 {
        self.file_size
    }

    /// Find a trade by id. The Bloom filter and the min/max id rule out most
    /// misses without touching the disk; a possible hit scans the data.
    pub fn get(&self, trade_id: u64) -> Result<Option<Trade>, DbError> {
        if self.count == 0
            || trade_id < self.min_id
            || trade_id > self.max_id
            || !self.bloom.might_contain(trade_id)
        {
            return Ok(None);
        }
        for t in self.records_from(0)? {
            let t = t?;
            if t.trade_id == trade_id {
                return Ok(Some(t));
            }
        }
        Ok(None)
    }

    /// Trades with start_ms <= timestamp_ms < end_ms, in file order.
    /// The sparse index lets us skip straight to the right part of the file.
    pub fn range(&self, start_ms: u64, end_ms: u64) -> Result<Vec<Trade>, DbError> {
        let before_start = self.index.partition_point(|&(ts, _, _)| ts < start_ms);
        let offset = if before_start == 0 {
            0
        } else {
            self.index[before_start - 1].2
        };
        let mut out = Vec::new();
        for t in self.records_from(offset)? {
            let t = t?;
            if t.timestamp_ms >= end_ms {
                break;
            }
            if t.timestamp_ms >= start_ms {
                out.push(t);
            }
        }
        Ok(out)
    }

    /// Every trade, in file order.
    pub fn all(&self) -> Result<Vec<Trade>, DbError> {
        self.records_from(0)?.collect()
    }

    /// Iterator over the records that start at `offset` (a record boundary).
    fn records_from(&self, offset: u64) -> Result<Records, DbError> {
        let mut file = File::open(&self.path)?;
        file.seek(SeekFrom::Start(offset))?;
        Ok(Records {
            reader: BufReader::new(file.take(self.data_len - offset)),
        })
    }
}

/// Reads trade records one by one until the data section ends.
struct Records {
    reader: BufReader<std::io::Take<File>>,
}

impl Iterator for Records {
    type Item = Result<Trade, DbError>;

    fn next(&mut self) -> Option<Self::Item> {
        let mut head = [0u8; 66];
        match self.reader.read(&mut head[..1]) {
            Ok(0) => return None, // clean end of the data section
            Ok(_) => {}
            Err(e) => return Some(Err(e.into())),
        }
        if let Err(e) = self.reader.read_exact(&mut head[1..]) {
            return Some(Err(e.into()));
        }
        let sym_len = u16::from_le_bytes([head[64], head[65]]) as usize;
        let mut rec = head.to_vec();
        rec.resize(66 + sym_len, 0);
        if let Err(e) = self.reader.read_exact(&mut rec[66..]) {
            return Some(Err(e.into()));
        }
        match Trade::decode(&rec) {
            Some((t, _)) => Some(Ok(t)),
            None => Some(Err(corrupt("bad record in SSTable"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trade(id: u64, ts: u64) -> Trade {
        Trade {
            trade_id: id,
            symbol: if id.is_multiple_of(2) {
                "AAPL".into()
            } else {
                "MSFT".into()
            },
            price_cents: 10_000 + id as i64,
            quantity: 1 + id % 50,
            buy_order_id: id * 2,
            sell_order_id: id * 2 + 1,
            buyer_id: id % 24,
            seller_id: (id + 1) % 24,
            timestamp_ms: ts,
        }
    }

    /// 1000 trades, two per millisecond, ids ascending.
    fn sample() -> Vec<Trade> {
        (0..1000u64).map(|i| trade(i + 1, 1_000 + i / 2)).collect()
    }

    fn write_sample(dir: &Path) -> (PathBuf, Vec<Trade>) {
        let path = dir.join("sst-1.tfs");
        let trades = sample();
        SsTable::write(&path, &trades).unwrap();
        (path, trades)
    }

    #[test]
    fn round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let (path, trades) = write_sample(dir.path());
        let t = SsTable::open(&path).unwrap();
        assert_eq!(t.len(), 1000);
        assert_eq!(t.all().unwrap(), trades);
        for id in [1u64, 64, 65, 500, 1000] {
            assert_eq!(t.get(id).unwrap().unwrap(), trades[id as usize - 1]);
        }
        assert!(t.get(0).unwrap().is_none());
        assert!(t.get(1001).unwrap().is_none());
        assert!(!dir.path().join("sst-1.tfs.tmp").exists());
    }

    #[test]
    fn range_uses_half_open_interval() {
        let dir = tempfile::tempdir().unwrap();
        let (path, trades) = write_sample(dir.path());
        let t = SsTable::open(&path).unwrap();
        for (start, end) in [
            (0, 10_000),
            (1_000, 1_001),
            (1_100, 1_300),
            (1_499, 1_500),
            (1_500, 1_600),
            (2_000, 3_000),
            (1_250, 1_250),
        ] {
            let expect: Vec<Trade> = trades
                .iter()
                .filter(|x| x.timestamp_ms >= start && x.timestamp_ms < end)
                .cloned()
                .collect();
            assert_eq!(t.range(start, end).unwrap(), expect, "range {start}..{end}");
        }
    }

    #[test]
    fn any_flipped_byte_is_detected() {
        let dir = tempfile::tempdir().unwrap();
        let trades: Vec<Trade> = (0..20u64).map(|i| trade(i + 1, 1_000 + i)).collect();
        let path = dir.path().join("sst-1.tfs");
        SsTable::write(&path, &trades).unwrap();
        let good = fs::read(&path).unwrap();
        for i in 0..good.len() {
            let mut bad = good.clone();
            bad[i] ^= 0x01;
            fs::write(&path, &bad).unwrap();
            assert!(
                SsTable::open(&path).is_err(),
                "flip at byte {i} was not detected"
            );
        }
    }

    #[test]
    fn truncated_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let (path, _) = write_sample(dir.path());
        let good = fs::read(&path).unwrap();
        for cut in [0, 10, FOOTER_LEN - 1, good.len() / 2, good.len() - 1] {
            fs::write(&path, &good[..cut]).unwrap();
            assert!(
                SsTable::open(&path).is_err(),
                "cut at {cut} was not detected"
            );
        }
    }

    #[test]
    fn empty_table_works() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sst-1.tfs");
        SsTable::write(&path, &[]).unwrap();
        let t = SsTable::open(&path).unwrap();
        assert!(t.is_empty());
        assert!(t.get(1).unwrap().is_none());
        assert!(t.range(0, 100).unwrap().is_empty());
    }
}
