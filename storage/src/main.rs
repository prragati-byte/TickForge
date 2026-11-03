//Main function hamare database prototype ka entry point hai ismein main database open karti hoon, sample trade create karti hoon, insert aur read operation call karti hoon, aur output se verify karti hoon ki basic flow work kar raha hai

//Dono lines ka matlab hai ki main.rs ko doosri files mein defined types use karne hain

//Rust mein use ka kaam kisi doosre module ke naam ko current file mein available karana hai

use tickforge_db::database::Database;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let db = Database::open("data/wal.log")?;

    println!("TickForge Rust Database is ready.");
    println!("Recovered records: {}", db.memtable_len());
    println!("Database is ready to accept trade records through its library API.");

    Ok(())
}
