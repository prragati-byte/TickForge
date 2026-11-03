// tickforge-db/src/bloom.rs
// Simple Bloom filter for SSTable membership checks.
// Uses k=3 independent hash functions over a fixed-size bit array.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

pub struct BloomFilter {
    bits: Vec<u64>,  // 64-bit words
    num_bits: usize,
    k: usize,        // number of hash functions
}

impl BloomFilter {
    /// Create a Bloom filter sized for `capacity` items at `fp_rate` false-positive rate.
    pub fn new(capacity: usize, fp_rate: f64) -> Self {
        // m = -(n * ln(p)) / (ln 2)^2
        let m = (-(capacity as f64 * fp_rate.ln()) / (2.0_f64.ln().powi(2))).ceil() as usize;
        let m = m.max(64);
        // k = (m/n) * ln 2
        let k = ((m as f64 / capacity as f64) * 2.0_f64.ln()).round() as usize;
        let k = k.clamp(1, 8);
        let words = (m + 63) / 64;
        BloomFilter {
            bits: vec![0u64; words],
            num_bits: words * 64,
            k,
        }
    }

    /// Insert a key into the filter.
    pub fn insert<T: Hash>(&mut self, item: &T) {
        for i in 0..self.k {
            let idx = self.hash(item, i as u64) % self.num_bits;
            self.bits[idx / 64] |= 1u64 << (idx % 64);
        }
    }

    /// Test membership. May return true for non-members (false positive).
    /// Never returns false for actual members.
    pub fn may_contain<T: Hash>(&self, item: &T) -> bool {
        for i in 0..self.k {
            let idx = self.hash(item, i as u64) % self.num_bits;
            if self.bits[idx / 64] & (1u64 << (idx % 64)) == 0 {
                return false;
            }
        }
        true
    }

    fn hash<T: Hash>(&self, item: &T, seed: u64) -> usize {
        let mut hasher = DefaultHasher::new();
        seed.hash(&mut hasher);
        item.hash(&mut hasher);
        hasher.finish() as usize
    }

    pub fn bit_count(&self) -> usize {
        self.num_bits
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_false_negatives() {
        let mut bf = BloomFilter::new(1000, 0.01);
        for i in 0u64..500 {
            bf.insert(&i);
        }
        for i in 0u64..500 {
            assert!(bf.may_contain(&i), "False negative at {i}");
        }
    }

    #[test]
    fn false_positive_rate_low() {
        let mut bf = BloomFilter::new(1000, 0.01);
        for i in 0u64..1000 {
            bf.insert(&i);
        }
        let fp_count = (1000u64..2000)
            .filter(|x| bf.may_contain(x))
            .count();
        // Allow up to 3× the target rate (~3%)
        assert!(fp_count < 30, "Too many false positives: {fp_count}");
    }
}
