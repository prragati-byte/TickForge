cmake_minimum_required(VERSION 3.15)
project(TickForgeMatchingEngine CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Threads REQUIRED)

# ── Include directories ────────────────────────────────────────────────────────
include_directories(
    include
    ../include          # wal/wal_*.hpp, order.hpp
)

# ── Shared WAL static library (C++ WAL for engine_server) ────────────────────
add_library(tickforge_wal STATIC
    ../src/wal/wal_writer.cpp
    ../src/wal/wal_reader.cpp
    ../src/wal/wal_record.cpp
    ../src/wal/wal_database.cpp
)
target_include_directories(tickforge_wal PUBLIC ../include include)
target_compile_options(tickforge_wal PRIVATE -O2 -Wall -Wextra)

# ── Shared order_book object ──────────────────────────────────────────────────
add_library(order_book_lib STATIC src/order_book.cpp)
target_include_directories(order_book_lib PUBLIC include)
target_compile_options(order_book_lib PRIVATE -O2)

# ── Original demo binary ──────────────────────────────────────────────────────
add_executable(matching_engine
    src/main.cpp
)
target_include_directories(matching_engine PRIVATE include)
target_link_libraries(matching_engine PRIVATE order_book_lib Threads::Threads)
target_compile_options(matching_engine PRIVATE -O2 -Wall)

# ── Engine Server (the Unix-socket bridge missing until now) ──────────────────
add_executable(engine_server
    src/engine_server.cpp
    src/order_book.cpp
)
target_include_directories(engine_server PRIVATE include ../include)
target_link_libraries(engine_server PRIVATE tickforge_wal Threads::Threads)
target_compile_options(engine_server PRIVATE -O2 -Wall -Wextra)

# ── Google Test (fetched via cmake FetchContent) ──────────────────────────────
include(FetchContent)
FetchContent_Declare(
    googletest
    URL https://github.com/google/googletest/archive/refs/tags/v1.14.0.zip
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(googletest)

enable_testing()

# ── Order book unit tests ─────────────────────────────────────────────────────
add_executable(order_book_tests
    tests/order_book_tests.cpp
    src/order_book.cpp
)
target_include_directories(order_book_tests PRIVATE include)
target_link_libraries(order_book_tests PRIVATE GTest::gtest Threads::Threads)
target_compile_options(order_book_tests PRIVATE -O0 -g -Wall)
add_test(NAME OrderBookTests COMMAND order_book_tests)

# ── Queue stress test ─────────────────────────────────────────────────────────
add_executable(queue_stress_test
    tests/queue_stress_test.cpp
)
target_include_directories(queue_stress_test PRIVATE include)
target_link_libraries(queue_stress_test PRIVATE Threads::Threads)
target_compile_options(queue_stress_test PRIVATE -O2 -Wall)
add_test(NAME QueueStress COMMAND queue_stress_test)

# ── Lock-free vs mutex benchmark ─────────────────────────────────────────────
add_executable(lockfree_vs_mutex_bench
    benchmarks/lockfree_vs_mutex_bench.cpp
)
target_include_directories(lockfree_vs_mutex_bench PRIVATE include)
target_link_libraries(lockfree_vs_mutex_bench PRIVATE Threads::Threads)
target_compile_options(lockfree_vs_mutex_bench PRIVATE -O2 -Wall)

# ── B+tree (std::map) order-book baseline benchmark ──────────────────────────
add_executable(btree_baseline
    benchmarks/btree_baseline.cpp
    src/order_book.cpp
)
target_include_directories(btree_baseline PRIVATE include)
target_link_libraries(btree_baseline PRIVATE Threads::Threads)
target_compile_options(btree_baseline PRIVATE -O2 -Wall)
