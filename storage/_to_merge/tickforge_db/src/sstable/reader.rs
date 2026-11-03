// SSTable file se records wapas padhne ka kaam yahan hota hai
// writer.rs ne jo JSON lines likhi thi unhe yahan se read karte hain

use crate::record::TradeRecord;
use std::fs::File;
use std::io::{BufRead, BufReader};

// poori SSTable file padh ke saare trades return karta hai
pub fn read_sstable(path: &str) -> std::io::Result<Vec<TradeRecord>> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let mut trades = Vec::new();

    for (i, line) in reader.lines().enumerate() {
        let line = line?;

        if line.trim().is_empty() {
            continue;
        }

        match serde_json::from_str::<TradeRecord>(&line) {
            Ok(trade) => trades.push(trade),
            Err(e) => {
                // kharab line hai toh skip karo, poora program mat todo
                eprintln!("SSTABLE: line {} corrupt hai, skip kar rahi hoon — {}", i + 1, e);
            }
        }
    }

    println!("SSTABLE: {} records padhe gaye {}", trades.len(), path);
    Ok(trades)
}

// ek specific trade dhundhna ho toh yeh function use karo
pub fn find_trade_in_sstable(path: &str, trade_id: u64) -> std::io::Result<Option<TradeRecord>> {
    let trades = read_sstable(path)?;
    Ok(trades.into_iter().find(|t| t.trade_id == trade_id))
}
