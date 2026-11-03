cmake_minimum_required(VERSION 3.16)
project(TickForgeEngine CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Optimised build unless the caller chooses one.
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Threads REQUIRED)
add_compile_options(-Wall -Wextra)
include_directories(include)

# WAL library: used by the server and the tests.
add_library(tickforge_wal STATIC src/wal.cpp)

# The server.
add_executable(engine_server src/engine_server.cpp)
target_link_libraries(engine_server PRIVATE tickforge_wal Threads::Threads)

# ---- tests (run with: ctest --output-on-failure) ----------------------------
enable_testing()

add_executable(order_book_tests tests/order_book_tests.cpp)
target_link_libraries(order_book_tests PRIVATE tickforge_wal)
add_test(NAME order_book_tests COMMAND order_book_tests)

add_executable(wal_recovery_test tests/wal_recovery_test.cpp)
target_link_libraries(wal_recovery_test PRIVATE tickforge_wal)
add_test(NAME wal_recovery_test COMMAND wal_recovery_test)

add_executable(queue_stress_test tests/queue_stress_test.cpp)
target_link_libraries(queue_stress_test PRIVATE Threads::Threads)
add_test(NAME queue_stress_test COMMAND queue_stress_test)

# Starts engine_server, kills it with SIGKILL, restarts it and compares state hashes.
add_executable(engine_e2e_test tests/engine_e2e_test.cpp)
add_test(NAME engine_e2e_test COMMAND engine_e2e_test $<TARGET_FILE:engine_server>)

# The same crash test on the elastic queue. A ring of 2 sends nearly every queued
# order through the overflow path.
add_test(NAME engine_e2e_elastic COMMAND engine_e2e_test $<TARGET_FILE:engine_server> --queue elastic)
add_test(NAME engine_e2e_elastic_tiny_ring
         COMMAND engine_e2e_test $<TARGET_FILE:engine_server> --queue elastic --ring-size 2)

add_executable(elastic_ring_test tests/elastic_ring_test.cpp)
target_link_libraries(elastic_ring_test PRIVATE Threads::Threads)
add_test(NAME elastic_ring_test COMMAND elastic_ring_test)
set_tests_properties(elastic_ring_test PROPERTIES TIMEOUT 120) # a broken ring hangs instead of failing

# Core pinning: plan logic, then each thread's allowed CPUs read from /proc.
add_executable(pinning_test tests/pinning_test.cpp)
add_test(NAME pinning_test COMMAND pinning_test $<TARGET_FILE:engine_server>)

# The same queue tests again with ThreadSanitizer and AddressSanitizer.
foreach(san thread address)
  foreach(name queue_stress elastic_ring)
    if(name STREQUAL "queue_stress")
      set(source tests/queue_stress_test.cpp)
    else()
      set(source tests/elastic_ring_test.cpp)
    endif()
    add_executable(${name}_${san} ${source})
    target_compile_options(${name}_${san} PRIVATE -fsanitize=${san} -O1 -g -fno-omit-frame-pointer)
    target_link_options(${name}_${san} PRIVATE -fsanitize=${san})
    target_link_libraries(${name}_${san} PRIVATE Threads::Threads)
    add_test(NAME ${name}_${san} COMMAND ${name}_${san})
    set_tests_properties(${name}_${san} PROPERTIES TIMEOUT 300)
  endforeach()
endforeach()

# The real server under the sanitizers, on the elastic queue, with the crash test
# driving it. ctest fails the test if a sanitizer prints anything.
foreach(san thread address)
  add_executable(engine_server_${san} src/engine_server.cpp src/wal.cpp)
  target_compile_options(engine_server_${san} PRIVATE -fsanitize=${san} -O1 -g -fno-omit-frame-pointer)
  target_link_options(engine_server_${san} PRIVATE -fsanitize=${san})
  target_link_libraries(engine_server_${san} PRIVATE Threads::Threads)
  add_test(NAME engine_e2e_elastic_${san}
           COMMAND engine_e2e_test $<TARGET_FILE:engine_server_${san}> --queue elastic --ring-size 8)
  set_tests_properties(engine_e2e_elastic_${san} PROPERTIES
    FAIL_REGULAR_EXPRESSION "ThreadSanitizer|AddressSanitizer|LeakSanitizer")
endforeach()

# ---- benchmark (run: ./engine_bench > bench/last_run.md) ---------------------
add_executable(engine_bench bench/engine_bench.cpp)
target_link_libraries(engine_bench PRIVATE Threads::Threads)
target_compile_definitions(engine_bench PRIVATE
  "TF_BUILD_FLAGS=\"-std=c++17 ${CMAKE_CXX_FLAGS_RELEASE}\"")

# Whole-server benchmark, used to compare engine flags under the same load.
add_executable(server_bench bench/server_bench.cpp)
target_link_libraries(server_bench PRIVATE Threads::Threads)
