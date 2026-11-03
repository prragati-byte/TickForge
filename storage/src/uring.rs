//! Write a whole file through io_uring: batched, asynchronous and, where the file
//! system allows it, O_DIRECT so that a large SSTable does not push the rest of
//! the machine out of the page cache.
//!
//! The file is written in 1 MiB chunks with up to 8 in flight, then cut to its
//! exact length and fsynced. The result is byte for byte what `write_all` would give.
//!
//! O_DIRECT needs a block-aligned buffer and length; not every file system accepts
//! it (tmpfs often does not), and in that case the same path runs without it.

use io_uring::{opcode, types, IoUring};
use std::alloc::{alloc_zeroed, dealloc, Layout};
use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

const BLOCK: usize = 4096;
const CHUNK: usize = 1 << 20;
const QUEUE_DEPTH: u32 = 8;

/// Can this kernel and sandbox create a ring? Checked by creating one, because
/// containers and sysctl can block io_uring on a kernel that was built with it.
pub fn supported() -> io::Result<()> {
    IoUring::new(2).map(|_| ())
}

/// A zeroed, block-aligned copy of `data`, padded to a whole number of blocks.
struct AlignedBuf {
    ptr: *mut u8,
    layout: Layout,
}

impl AlignedBuf {
    fn new(data: &[u8]) -> AlignedBuf {
        let padded = data.len().div_ceil(BLOCK).max(1) * BLOCK;
        let layout = Layout::from_size_align(padded, BLOCK).expect("valid layout");
        // SAFETY: the layout has a non-zero size.
        let ptr = unsafe { alloc_zeroed(layout) };
        if ptr.is_null() {
            std::alloc::handle_alloc_error(layout);
        }
        // SAFETY: `ptr` has room for `padded` >= data.len() bytes and is a new allocation.
        unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len()) };
        AlignedBuf { ptr, layout }
    }

    fn len(&self) -> usize {
        self.layout.size()
    }
}

impl Drop for AlignedBuf {
    fn drop(&mut self) {
        // SAFETY: allocated in `new` with this layout.
        unsafe { dealloc(self.ptr, self.layout) };
    }
}

/// Wait for at least one completion. A signal during the wait is not an error.
fn wait_one(ring: &mut IoUring) -> io::Result<()> {
    loop {
        match ring.submit_and_wait(1) {
            Ok(_) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
}

/// Everything in `buf` is written at its own offset. A failed write stops further
/// submissions, and this waits for the requests already in flight before returning,
/// so `buf` can be freed or the ring reused afterwards. (The one exception is the ring
/// itself failing, after which it is dropped before `buf`, see `write_file`.)
fn write_chunks(ring: &mut IoUring, file: &File, buf: &AlignedBuf) -> io::Result<()> {
    let fd = types::Fd(file.as_raw_fd());
    let total = buf.len();
    let mut next_offset = 0usize;
    // (offset, length) still to be written again after a short write.
    let mut retry: Vec<(usize, usize)> = Vec::new();
    let mut in_flight: u32 = 0;
    let mut failure: Option<io::Error> = None;
    // user_data carries offset and length. Lengths are at most CHUNK (1 << 20), which
    // needs 21 bits; that leaves 43 bits for the offset, far more than an SSTable needs.
    let encode = |off: usize, len: usize| ((off as u64) << 21) | (len as u64);
    let decode = |v: u64| ((v >> 21) as usize, (v & 0x1f_ffff) as usize);

    loop {
        while failure.is_none() && in_flight < QUEUE_DEPTH && (next_offset < total || !retry.is_empty()) {
            let (off, len) = retry.pop().unwrap_or_else(|| {
                let len = CHUNK.min(total - next_offset);
                let off = next_offset;
                next_offset += len;
                (off, len)
            });
            // SAFETY: `off + len` is inside the buffer.
            let ptr = unsafe { buf.ptr.add(off) };
            let entry = opcode::Write::new(fd, ptr, len as u32)
                .offset(off as u64)
                .build()
                .user_data(encode(off, len));
            // SAFETY: the buffer and the file stay valid until the completion arrives,
            // because this function waits for every request it submitted.
            unsafe { ring.submission().push(&entry) }
                .map_err(|_| io::Error::other("io_uring submission queue is full"))?;
            in_flight += 1;
        }
        if in_flight == 0 {
            break; // nothing was left to submit, or a failure stopped the submitting
        }
        wait_one(ring)?;
        let completed: Vec<(i32, u64)> = ring.completion().map(|c| (c.result(), c.user_data())).collect();
        for (res, data) in completed {
            in_flight -= 1;
            let (off, len) = decode(data);
            if res < 0 {
                let code = -res;
                if code == libc::EINTR || code == libc::EAGAIN {
                    retry.push((off, len));
                } else if failure.is_none() {
                    failure = Some(io::Error::from_raw_os_error(code));
                }
            } else if res == 0 {
                failure.get_or_insert_with(|| io::Error::new(io::ErrorKind::WriteZero, "io_uring wrote nothing"));
            } else if (res as usize) < len {
                retry.push((off + res as usize, len - res as usize));
            }
        }
    }
    failure.map_or(Ok(()), Err)
}

fn fsync(ring: &mut IoUring, file: &File) -> io::Result<()> {
    let entry = opcode::Fsync::new(types::Fd(file.as_raw_fd())).build();
    // SAFETY: the file stays open until the completion arrives; we wait for it here.
    unsafe { ring.submission().push(&entry) }
        .map_err(|_| io::Error::other("io_uring submission queue is full"))?;
    wait_one(ring)?;
    let res = ring
        .completion()
        .next()
        .ok_or_else(|| io::Error::other("io_uring: no completion for fsync"))?
        .result();
    if res < 0 {
        return Err(io::Error::from_raw_os_error(-res));
    }
    Ok(())
}

fn open(path: &Path, direct: bool) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .custom_flags(if direct { libc::O_DIRECT } else { 0 })
        .open(path)
}

fn write_through(ring: &mut IoUring, path: &Path, buf: &AlignedBuf, direct: bool, exact: u64) -> io::Result<()> {
    let file = open(path, direct)?;
    write_chunks(ring, &file, buf)?;
    file.set_len(exact)?;
    fsync(ring, &file)
}

/// Create `path` with exactly `data` in it and fsync it.
/// Returns true if O_DIRECT was used.
pub fn write_file(path: &Path, data: &[u8]) -> io::Result<bool> {
    let buf = AlignedBuf::new(data);
    let mut ring = IoUring::new(QUEUE_DEPTH)?;
    match write_through(&mut ring, path, &buf, true, data.len() as u64) {
        Ok(()) => Ok(true),
        // The file system does not do O_DIRECT, either at open or at the first write.
        Err(e) if e.raw_os_error() == Some(libc::EINVAL) => {
            write_through(&mut ring, path, &buf, false, data.len() as u64)?;
            Ok(false)
        }
        Err(e) => Err(e),
    }
}
