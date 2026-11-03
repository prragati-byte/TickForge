#pragma once
// A tiny test helper so the tests need no external framework.
//   CHECK(cond)   records a failure and keeps going
//   finish()      call at the end of main(); returns the exit code
#include <cstdio>

inline int &failure_count() {
  static int n = 0;
  return n;
}

#define CHECK(cond)                                                              \
  do {                                                                           \
    if (!(cond)) {                                                               \
      std::fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond); \
      failure_count()++;                                                         \
    }                                                                            \
  } while (0)

inline int finish(const char *name) {
  if (failure_count() == 0) {
    std::printf("%s: PASS\n", name);
    return 0;
  }
  std::printf("%s: FAIL (%d checks failed)\n", name, failure_count());
  return 1;
}
