use crate::record::TradeRecord;

pub fn before_insert(trade: &TradeRecord) -> Result<(), String> {
    if trade.price_paise == 0 {
        return Err("Price must be greater than zero".to_string());
    }

    if trade.quantity == 0 {
        return Err("Quantity must be greater than zero".to_string());
    }

    if trade.symbol.trim().is_empty() {
        return Err("Stock symbol cannot be empty".to_string());
    }

    println!("BEFORE INSERT: Trade validation passed");
    Ok(())
}

pub fn after_insert(trade: &TradeRecord) {
    println!(
        "AFTER INSERT: Trade {} accepted for {}",
        trade.trade_id, trade.symbol
    );
}
