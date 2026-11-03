use crate::error::DbError;

/// One executed trade. Prices are integer cents, times are milliseconds.
#[derive(Debug, Clone, PartialEq)]
pub struct Trade {
    pub trade_id: u64,
    pub symbol: String,
    pub price_cents: i64,
    pub quantity: u64,
    pub buy_order_id: u64,
    pub sell_order_id: u64,
    pub buyer_id: u64,
    pub seller_id: u64,
    pub timestamp_ms: u64,
}

/// Bytes before the symbol: eight 8-byte numbers and a 2-byte symbol length.
const FIXED_LEN: usize = 8 * 8 + 2;

impl Trade {
    pub fn validate(&self) -> Result<(), DbError> {
        if self.symbol.is_empty() || self.symbol.len() > 32 {
            return Err(DbError::Invalid("symbol must be 1 to 32 bytes".into()));
        }
        if self.price_cents <= 0 {
            return Err(DbError::Invalid("price_cents must be positive".into()));
        }
        if self.quantity == 0 {
            return Err(DbError::Invalid("quantity must be positive".into()));
        }
        Ok(())
    }

    /// Append the binary form (little-endian) to `out`.
    pub fn encode(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.trade_id.to_le_bytes());
        out.extend_from_slice(&self.timestamp_ms.to_le_bytes());
        out.extend_from_slice(&self.price_cents.to_le_bytes());
        out.extend_from_slice(&self.quantity.to_le_bytes());
        out.extend_from_slice(&self.buy_order_id.to_le_bytes());
        out.extend_from_slice(&self.sell_order_id.to_le_bytes());
        out.extend_from_slice(&self.buyer_id.to_le_bytes());
        out.extend_from_slice(&self.seller_id.to_le_bytes());
        out.extend_from_slice(&(self.symbol.len() as u16).to_le_bytes());
        out.extend_from_slice(self.symbol.as_bytes());
    }

    /// Read one trade from the start of `buf`. Returns the trade and the
    /// number of bytes used, or None if `buf` is too short or damaged.
    pub fn decode(buf: &[u8]) -> Option<(Trade, usize)> {
        if buf.len() < FIXED_LEN {
            return None;
        }
        let num = |i: usize| u64::from_le_bytes(buf[i * 8..i * 8 + 8].try_into().unwrap());
        let sym_len = u16::from_le_bytes([buf[64], buf[65]]) as usize;
        let total = FIXED_LEN + sym_len;
        if buf.len() < total {
            return None;
        }
        let symbol = String::from_utf8(buf[FIXED_LEN..total].to_vec()).ok()?;
        let trade = Trade {
            trade_id: num(0),
            timestamp_ms: num(1),
            price_cents: num(2) as i64,
            quantity: num(3),
            buy_order_id: num(4),
            sell_order_id: num(5),
            buyer_id: num(6),
            seller_id: num(7),
            symbol,
        };
        Some((trade, total))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn sample(id: u64, ts: u64) -> Trade {
        Trade {
            trade_id: id,
            symbol: "AAPL".into(),
            price_cents: 18950,
            quantity: 60,
            buy_order_id: 4021,
            sell_order_id: 3990,
            buyer_id: 7,
            seller_id: 12,
            timestamp_ms: ts,
        }
    }

    #[test]
    fn encode_decode_round_trip() {
        let t = sample(903, 1_767_225_600_123);
        let mut buf = Vec::new();
        t.encode(&mut buf);
        let (back, used) = Trade::decode(&buf).unwrap();
        assert_eq!(back, t);
        assert_eq!(used, buf.len());
    }

    #[test]
    fn decode_rejects_short_input() {
        let mut buf = Vec::new();
        sample(1, 1).encode(&mut buf);
        assert!(Trade::decode(&buf[..buf.len() - 1]).is_none());
        assert!(Trade::decode(&buf[..10]).is_none());
    }

    #[test]
    fn validate_rejects_bad_values() {
        let mut t = sample(1, 1);
        assert!(t.validate().is_ok());
        t.price_cents = 0;
        assert!(t.validate().is_err());
        t = sample(1, 1);
        t.quantity = 0;
        assert!(t.validate().is_err());
        t = sample(1, 1);
        t.symbol = String::new();
        assert!(t.validate().is_err());
    }
}
