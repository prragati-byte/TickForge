#pragma once
// A very small io_uring wrapper for one job: write a buffer to a file and wait
// for the result. It uses the kernel interface directly, so building the engine
// needs no extra library.
#include <cstddef>
#include <string>

class UringWriter {
public:
  // Can this kernel and sandbox really create a ring? Checks by creating one, because
  // containers and sysctl can block io_uring on a kernel that was built with it.
  // On false, `why` says what stopped it.
  static bool supported(std::string *why = nullptr);

  UringWriter();  // throws std::runtime_error if a ring cannot be created
  ~UringWriter();
  UringWriter(const UringWriter &) = delete;
  UringWriter &operator=(const UringWriter &) = delete;

  // Write everything at the file's position (the end, for an O_APPEND file) and
  // wait until the kernel has finished. Same guarantee as write(): when this
  // returns, the data survives a killed process. Throws on failure. Not thread safe.
  void write_all(int fd, const void *data, size_t len);

private:
  struct Ring;
  Ring *ring_ = nullptr;
};
