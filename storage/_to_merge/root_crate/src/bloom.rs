// Bloom Filter — probabilistic set membership data structure.
//
// Kaam kaise karta hai:
//   might_contain(key) = false → key DEFINITELY nahi hai (no false negatives)
//   might_contain(key) = true  → key SHAYAD hai (~1% false positive rate)
//
// SSTable ke saath use:
//   Har SSTable ka ek Bloom filter hota hai.
//   get_trade(id) mein: pehle bloom.might_contain(id) check karo.
//   Agar false → SSTable file disk se read mat karo (I/O save).
//   Agar true  → file padho, confirm karo.
//
// Hash functions: double-hashing trick
//   h_i(x) = (h1(x) + i × h2(x)) mod m
//   h1 = FNV-1a 64-bit, h2 = golden-ratio seeded variant
//
// Default parameters (with_capacity):
//   m = 10 × n_items bits (target ~1% FPR)
//   k = 7 hash functions (optimal for m/n = 10)
//
// Persistence: hex string in SSTable footer (BLOOM_M, BLOOM_K, BLOOM lines).

use crate::error::DbError;

#[derive(Debug, Clone)]
pub struct BloomFilter {
    bits: Vec<u8>, // bit array, packed into bytes
    m: usize,      // total bits
    k: u32,        // number of hash functions
}

impl BloomFilter {
    /// Naya Bloom filter banao.
    /// m: total bits (byte-aligned), k: hash function count.
    pub fn new(m: usize, k: u32) -> Self {
        // m ko byte-boundary par round up karo
        let m = ((m + 7) / 8) * 8;
        Self {
            bits: vec![0u8; m / 8],
            m,
            k,
        }
    }

    /// Bloom filter banao jo n_items ke liye ~1% FPR deta hai.
    /// m = 10 × n_items bits (minimum 256 bits = 32 bytes)
    pub fn with_capacity(n_items: usize) -> Self {
        let m = (10 * n_items.max(1)).max(256);
        Self::new(m, 7)
    }

    /// Ek trade_id insert karo.
    pub fn insert(&mut self, key: u64) {
        for i in 0..self.k {
            let idx = self.bit_index(key, i);
            self.bits[idx / 8] |= 1 << (idx % 8);
        }
    }

    /// Test karo: kya key is filter mein hai?
    /// false → definitely absent (safe to skip SSTable)
    /// true  → probably present (check SSTable)
    pub fn might_contain(&self, key: u64) -> bool {
        for i in 0..self.k {
            let idx = self.bit_index(key, i);
            if self.bits[idx / 8] & (1 << (idx % 8)) == 0 {
                return false; // at least one bit is 0 → key not present
            }
        }
        true
    }

    /// Bloom filter ko lowercase hex string mein serialize karo.
    /// SSTable footer mein store hota hai.
    pub fn to_hex(&self) -> String {
        self.bits.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Hex string se Bloom filter reconstruct karo (SSTable load ke waqt).
    pub fn from_hex(hex: &str, k: u32) -> Result<Self, DbError> {
        if hex.len() % 2 != 0 {
            return Err(DbError::Corrupt(
                "Bloom hex length odd hai".to_string(),
            ));
        }
        let mut bits = Vec::with_capacity(hex.len() / 2);
        for chunk in hex.as_bytes().chunks(2) {
            let byte_str = std::str::from_utf8(chunk)
                .map_err(|e| DbError::Corrupt(format!("Bloom hex UTF-8: {e}")))?;
            let b = u8::from_str_radix(byte_str, 16)
                .map_err(|e| DbError::Corrupt(format!("Bloom hex parse: {e}")))?;
            bits.push(b);
        }
        let m = bits.len() * 8;
        Ok(Self { bits, m, k })
    }

    pub fn m(&self) -> usize { self.m }
    pub fn k(&self) -> u32  { self.k }

    // ── Hash functions ──────────────────────────────────────────────────────

    // Double-hashing: h_i(x) = (h1(x) + i × h2(x)) % m
    fn bit_index(&self, key: u64, i: u32) -> usize {
        let h1 = fnv1a_64(key);
        // Golden-ratio seed: 0x9e3779b97f4a7c15 untuk beda distribusi
        let h2 = fnv1a_64(key ^ 0x9e3779b97f4a7c15);
        (h1.wrapping_add((i as u64).wrapping_mul(h2)) % self.m as u64) as usize
    }
}

/// FNV-1a 64-bit hash — fast, good avalanche properties.
fn fnv1a_64(mut val: u64) -> u64 {
    const FNV_PRIME:  u64 = 0x00000100000001B3;
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    let mut hash = FNV_OFFSET;
    for _ in 0..8 {
        hash ^= val & 0xFF;
        hash  = hash.wrapping_mul(FNV_PRIME);
        val >>= 8;
    }
    hash
}

// ── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inserted_key_always_found() {
        let mut bf = BloomFilter::with_capacity(100);
        for id in 1..=100u64 {
            bf.insert(id);
        }
        for id in 1..=100u64 {
            assert!(bf.might_contain(id), "id {id} must be found (no false negatives!)");
        }
    }

    #[test]
    fn not_inserted_key_usually_absent() {
        let mut bf = BloomFilter::with_capacity(100);
        for id in 1..=100u64 {
            bf.insert(id);
        }
        // Keys 1000-1999 were not inserted; at ~1% FPR, most should return false
        let fp_count = (1000..2000u64).filter(|&id| bf.might_contain(id)).count();
        // Allow up to 5% false positives (should be << 1%)
        assert!(fp_count < 50, "Too many false positives: {fp_count}/1000");
    }

    #[test]
    fn hex_roundtrip() {
        let mut bf = BloomFilter::with_capacity(10);
        bf.insert(42);
        bf.insert(1337);
        let hex = bf.to_hex();
        let restored = BloomFilter::from_hex(&hex, bf.k()).unwrap();
        assert!(restored.might_contain(42));
        assert!(restored.might_contain(1337));
    }

    #[test]
    fn empty_filter_returns_false() {
        let bf = BloomFilter::new(256, 3);
        assert!(!bf.might_contain(999));
    }
}
