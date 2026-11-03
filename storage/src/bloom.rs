/// A Bloom filter on trade ids.
/// `might_contain` is never wrong when it says "no", and wrong about 1% of the
/// time when it says "yes" (10 bits per key, 7 hash functions).
#[derive(Debug, Clone, PartialEq)]
pub struct Bloom {
    bits: Vec<u8>,
}

const HASHES: u64 = 7;
const BITS_PER_KEY: usize = 10;

/// A good 64-bit mixing function (splitmix64).
fn mix(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

impl Bloom {
    /// A filter sized for about `keys` entries.
    pub fn with_capacity(keys: usize) -> Bloom {
        let bits = (keys * BITS_PER_KEY).max(64);
        Bloom {
            bits: vec![0; bits.div_ceil(8)],
        }
    }

    fn positions(&self, key: u64) -> impl Iterator<Item = usize> {
        let total = (self.bits.len() * 8) as u64;
        let h1 = mix(key);
        let h2 = mix(h1) | 1;
        (0..HASHES).map(move |i| (h1.wrapping_add(i.wrapping_mul(h2)) % total) as usize)
    }

    pub fn insert(&mut self, key: u64) {
        for p in self.positions(key).collect::<Vec<_>>() {
            self.bits[p / 8] |= 1 << (p % 8);
        }
    }

    pub fn might_contain(&self, key: u64) -> bool {
        self.positions(key)
            .all(|p| self.bits[p / 8] & (1 << (p % 8)) != 0)
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bits
    }

    /// None if `bytes` is empty (a filter always has at least one byte).
    pub fn from_bytes(bytes: &[u8]) -> Option<Bloom> {
        if bytes.is_empty() {
            None
        } else {
            Some(Bloom {
                bits: bytes.to_vec(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_false_negatives() {
        let mut b = Bloom::with_capacity(10_000);
        for id in 0..10_000u64 {
            b.insert(id * 7 + 1);
        }
        for id in 0..10_000u64 {
            assert!(b.might_contain(id * 7 + 1));
        }
    }

    #[test]
    fn false_positive_rate_is_low() {
        let mut b = Bloom::with_capacity(10_000);
        for id in 0..10_000u64 {
            b.insert(id);
        }
        let false_hits = (1_000_000..1_020_000u64)
            .filter(|&id| b.might_contain(id))
            .count();
        // about 1% expected; allow up to 3%
        assert!(false_hits < 600, "false positives: {false_hits} of 20000");
    }

    #[test]
    fn survives_bytes_round_trip() {
        let mut b = Bloom::with_capacity(100);
        b.insert(42);
        let back = Bloom::from_bytes(b.as_bytes()).unwrap();
        assert_eq!(back, b);
        assert!(back.might_contain(42));
        assert!(Bloom::from_bytes(&[]).is_none());
    }
}
