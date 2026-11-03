// tickforge-db/build.rs
// Compiles the C++ WAL sources into a static library that Rust links against.
fn main() {
    let wal_sources = [
        "../src/wal/wal_writer.cpp",
        "../src/wal/wal_reader.cpp",
        "../src/wal/wal_record.cpp",
        "../src/wal/wal_database.cpp",
    ];

    let mut build = cc::Build::new();
    build
        .cpp(true)
        .std("c++17")
        .include("../include")                  // wal/wal_writer.hpp, wal/wal_record.hpp, etc.
        .include("../matching-engine/include")  // order.hpp (needed by wal_record.hpp)
        .flag_if_supported("-O2")
        .flag_if_supported("-Wall");

    for src in &wal_sources {
        build.file(src);
        println!("cargo:rerun-if-changed={src}");
    }

    // Rerun if any header changes
    println!("cargo:rerun-if-changed=../include/wal/wal_writer.hpp");
    println!("cargo:rerun-if-changed=../include/wal/wal_reader.hpp");
    println!("cargo:rerun-if-changed=../include/wal/wal_record.hpp");
    println!("cargo:rerun-if-changed=../include/wal/wal_database.hpp");
    println!("cargo:rerun-if-changed=../include/wal/db_state.hpp");
    println!("cargo:rerun-if-changed=../matching-engine/include/order.hpp");

    build.compile("tickforge_wal_static");
}
