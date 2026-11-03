#pragma once
// Thread-to-core pinning.
//
// The plan is a pure function so it can be tested on any machine. Applying it
// uses sched_setaffinity, which only exists on Linux; elsewhere pinning is
// reported as unavailable and the engine runs unpinned.
#include <algorithm>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

#ifdef __linux__
#include <sched.h>
#endif

namespace tf_affinity {

struct PinPlan {
  int matcher_core = -1;   // -1: do not pin
  std::vector<int> others; // every other thread may run on these
  std::string note;        // why pinning was skipped, or what was chosen
};

// CPUs this process may use. Respects taskset and cgroup limits. Empty if unknown.
inline std::vector<int> allowed_cpus() {
  std::vector<int> cpus;
#ifdef __linux__
  cpu_set_t set;
  CPU_ZERO(&set);
  if (sched_getaffinity(0, sizeof(set), &set) == 0)
    for (int i = 0; i < CPU_SETSIZE; i++)
      if (CPU_ISSET(i, &set)) cpus.push_back(i);
#endif
  return cpus;
}

// Parse a kernel CPU list such as "3,9" or "0-3,8". Bad input gives an empty list.
inline std::vector<int> parse_cpu_list(const std::string &text) {
  std::vector<int> out;
  size_t i = 0;
  while (i < text.size()) {
    size_t used = 0;
    int a = 0, b = 0;
    try {
      a = std::stoi(text.substr(i), &used);
    } catch (...) {
      return {};
    }
    i += used;
    b = a;
    if (i < text.size() && text[i] == '-') {
      i++;
      try {
        b = std::stoi(text.substr(i), &used);
      } catch (...) {
        return {};
      }
      i += used;
    }
    for (int c = a; c <= b; c++) out.push_back(c);
    if (i < text.size() && text[i] != ',' && text[i] != '\n') return {};
    i++;
  }
  return out;
}

// Hardware threads that share a physical core with `cpu`, as the OS reports it.
inline std::vector<int> smt_siblings(int cpu) {
  std::vector<int> out;
  std::string path = "/sys/devices/system/cpu/cpu" + std::to_string(cpu) + "/topology/thread_siblings_list";
  if (FILE *f = std::fopen(path.c_str(), "r")) {
    char buf[128] = {0};
    if (std::fgets(buf, sizeof(buf), f)) out = parse_cpu_list(buf);
    std::fclose(f);
  }
  return out;
}

// Decide where the threads go.
//   requested_core  >= 0 to choose the matcher's core; -1 for the default.
// The default is the last allowed CPU, because the kernel tends to keep
// interrupts and housekeeping on the low-numbered ones. The matcher's SMT
// sibling is left idle when there are enough CPUs to do that.
inline PinPlan make_plan(const std::vector<int> &allowed, int requested_core,
                         const std::function<std::vector<int>(int)> &siblings_of) {
  PinPlan plan;
  if (allowed.size() < 2) {
    plan.note = "fewer than 2 CPUs available, not pinning";
    return plan;
  }
  int core = requested_core >= 0 ? requested_core : allowed.back();
  if (std::find(allowed.begin(), allowed.end(), core) == allowed.end()) {
    plan.note = "core " + std::to_string(core) + " is not available to this process";
    return plan;
  }
  plan.matcher_core = core;
  std::vector<int> siblings = allowed.size() >= 4 ? siblings_of(core) : std::vector<int>{};
  for (int c : allowed)
    if (c != core && std::find(siblings.begin(), siblings.end(), c) == siblings.end())
      plan.others.push_back(c);
  plan.note = "matcher on core " + std::to_string(core) + ", " + std::to_string(plan.others.size()) +
              " CPUs for the other threads";
  return plan;
}

// Restrict the calling thread to `cpus`. Threads it starts afterwards inherit this.
inline bool set_current_thread(const std::vector<int> &cpus) {
#ifdef __linux__
  if (cpus.empty()) return false;
  cpu_set_t set;
  CPU_ZERO(&set);
  for (int c : cpus) CPU_SET(c, &set);
  return sched_setaffinity(0, sizeof(set), &set) == 0;
#else
  (void)cpus;
  return false;
#endif
}

} // namespace tf_affinity
