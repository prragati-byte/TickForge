// Triggers — Database events ke saath hook karne ka mechanism.
//
// Do trigger points hain:
//   BEFORE INSERT: Validation. Agar Err return hua to trade insert NAHI hoga.
//   AFTER INSERT : Side effects. Audit log, stats update, etc.
//                  Abhi non-fatal (failure insert roll back nahi karti).
//
// Registry pattern: TriggerRegistry struct mein closures store hote hain.
// Hardcoded functions ki jagah users apne khud ke triggers register kar sakte hain.
// Example:
//   let mut reg = TriggerRegistry::new();
//   reg.register_before(|t| { if t.price_paise > 1_000_000_00 { Err(...) } else { Ok(()) } });

use crate::error::DbError;
use crate::record::TradeRecord;

// ── Built-in validation (always runs, cannot be disabled) ─────────────────

/// Standard validation jo har insert se pehle hoti hai.
/// Yeh DbError::Validation return karta hai — caller ko pata chale kya wrong hua.
pub fn validate(trade: &TradeRecord) -> Result<(), DbError> {
    if trade.price_paise == 0 {
        return Err(DbError::Validation(
            "price_paise must be > 0 (zero-price trade rejected)".to_string(),
        ));
    }
    if trade.quantity == 0 {
        return Err(DbError::Validation(
            "quantity must be > 0".to_string(),
        ));
    }
    if trade.symbol.trim().is_empty() {
        return Err(DbError::Validation(
            "symbol cannot be empty".to_string(),
        ));
    }
    if trade.timestamp == 0 {
        return Err(DbError::Validation(
            "timestamp must be > 0 (unix ms expected)".to_string(),
        ));
    }
    Ok(())
}

// ── TriggerRegistry — user-defined hooks ──────────────────────────────────

type BeforeFn = Box<dyn Fn(&TradeRecord) -> Result<(), DbError> + Send + Sync>;
type AfterFn  = Box<dyn Fn(&TradeRecord) + Send + Sync>;

/// Insert triggers ka container.
/// `before` triggers validation ke baad, WAL se pehle chalta hai.
/// `after`  triggers successful MemTable insert ke baad chalta hai.
pub struct TriggerRegistry {
    before_fns: Vec<BeforeFn>,
    after_fns:  Vec<AfterFn>,
}

impl TriggerRegistry {
    /// Khaali registry banao.
    pub fn new() -> Self {
        Self {
            before_fns: Vec::new(),
            after_fns:  Vec::new(),
        }
    }

    /// Ek BEFORE INSERT trigger register karo.
    /// Err return karo to insert rok do.
    pub fn register_before<F>(&mut self, f: F)
    where
        F: Fn(&TradeRecord) -> Result<(), DbError> + Send + Sync + 'static,
    {
        self.before_fns.push(Box::new(f));
    }

    /// Ek AFTER INSERT trigger register karo (non-blocking side effect).
    pub fn register_after<F>(&mut self, f: F)
    where
        F: Fn(&TradeRecord) + Send + Sync + 'static,
    {
        self.after_fns.push(Box::new(f));
    }

    /// Sab BEFORE triggers run karo.
    /// Pehli failure par rok do (short-circuit).
    pub fn fire_before(&self, trade: &TradeRecord) -> Result<(), DbError> {
        for f in &self.before_fns {
            f(trade)?;
        }
        Ok(())
    }

    /// Sab AFTER triggers run karo.
    pub fn fire_after(&self, trade: &TradeRecord) {
        for f in &self.after_fns {
            f(trade);
        }
    }
}

impl Default for TriggerRegistry {
    fn default() -> Self {
        Self::new()
    }
}
