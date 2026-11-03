// Core pinning: the plan logic, then the real server.
//
//   pinning_test <path to engine_server>
//
// The server part reads each thread's allowed CPUs from /proc, so the test checks
// what the kernel enforces and not what the server says about itself.
#include "affinity.hpp"
#include "test_util.hpp"

#include <arpa/inet.h>
#include <csignal>
#include <dirent.h>
#include <fstream>
#include <map>
#include <netinet/in.h>
#include <string>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#include <vector>

using tf_affinity::make_plan;
using tf_affinity::parse_cpu_list;

static std::vector<int> no_siblings(int) { return {}; }
static std::vector<int> pairs(int c) { return {c & ~1, c | 1}; } // 0-1, 2-3, ...

static void test_plan() {
  CHECK((parse_cpu_list("0-3,8") == std::vector<int>{0, 1, 2, 3, 8}));
  CHECK((parse_cpu_list("5\n") == std::vector<int>{5}));
  CHECK(parse_cpu_list("x").empty());
  CHECK(parse_cpu_list("").empty());

  auto one = make_plan({3}, -1, no_siblings);
  CHECK(one.matcher_core == -1); // a single CPU: nothing to gain

  auto two = make_plan({0, 1}, -1, pairs);
  CHECK(two.matcher_core == 1);
  CHECK((two.others == std::vector<int>{0})); // too few CPUs to leave the sibling idle

  auto four = make_plan({0, 1, 2, 3}, -1, pairs);
  CHECK(four.matcher_core == 3);
  CHECK((four.others == std::vector<int>{0, 1})); // the sibling, 2, is left idle

  auto chosen = make_plan({0, 1, 2, 3}, 1, no_siblings);
  CHECK(chosen.matcher_core == 1);
  CHECK((chosen.others == std::vector<int>{0, 2, 3}));

  CHECK(make_plan({0, 1}, 7, no_siblings).matcher_core == -1); // not an allowed CPU
}

#ifdef __linux__

static pid_t start_server(const char *exe, int port, const std::string &wal,
                          const std::vector<std::string> &flags) {
  pid_t pid = fork();
  if (pid == 0) {
    std::vector<std::string> args = {exe, "--port", std::to_string(port), "--wal", wal};
    args.insert(args.end(), flags.begin(), flags.end());
    std::vector<char *> argv;
    for (auto &a : args) argv.push_back(&a[0]);
    argv.push_back(nullptr);
    execv(exe, argv.data());
    _exit(127);
  }
  return pid;
}

static bool wait_for_port(int port) {
  for (int i = 0; i < 100; i++) {
    int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons(static_cast<uint16_t>(port));
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    bool ok = ::connect(fd, reinterpret_cast<sockaddr *>(&a), sizeof(a)) == 0;
    ::close(fd);
    if (ok) return true;
    usleep(50 * 1000);
  }
  return false;
}

// thread name -> CPUs it may run on, for every thread of a process.
static std::multimap<std::string, std::vector<int>> thread_cpus(pid_t pid) {
  std::multimap<std::string, std::vector<int>> out;
  std::string dir = "/proc/" + std::to_string(pid) + "/task";
  DIR *d = opendir(dir.c_str());
  if (!d) return out;
  while (dirent *e = readdir(d)) {
    if (e->d_name[0] == '.') continue;
    std::string task = dir + "/" + e->d_name;
    std::string name, line, cpus;
    std::ifstream(task + "/comm") >> name;
    std::ifstream status(task + "/status");
    while (std::getline(status, line))
      if (line.rfind("Cpus_allowed_list:", 0) == 0) cpus = line.substr(line.find(':') + 1);
    cpus.erase(0, cpus.find_first_not_of(" \t"));
    out.emplace(name, parse_cpu_list(cpus));
  }
  closedir(d);
  return out;
}

static void stop(pid_t pid) {
  kill(pid, SIGTERM);
  waitpid(pid, nullptr, 0);
}

static void test_server(const char *exe) {
  std::vector<int> allowed = tf_affinity::allowed_cpus();
  if (allowed.size() < 2) {
    std::printf("  only %zu CPU: server part skipped\n", allowed.size());
    return;
  }
  char tmpl[] = "/tmp/tf_pin_XXXXXX";
  std::string dir = mkdtemp(tmpl);
  int port = 20000 + getpid() % 20000;

  { // --no-pin: every thread keeps the CPUs the process started with
    pid_t server = start_server(exe, port, dir + "/a.wal", {"--no-pin"});
    CHECK(wait_for_port(port));
    auto threads = thread_cpus(server);
    CHECK(threads.count("tf-matcher") == 1);
    for (auto &t : threads) CHECK(t.second == allowed);
    stop(server);
  }

  { // the default, the same as --pin: the matcher has one CPU and nothing else may run there
    pid_t server = start_server(exe, port, dir + "/b.wal", {});
    CHECK(wait_for_port(port));
    auto threads = thread_cpus(server);
    auto m = threads.find("tf-matcher");
    CHECK(m != threads.end());
    if (m != threads.end()) {
      CHECK((m->second == std::vector<int>{allowed.back()}));
      for (auto &t : threads) {
        if (t.first == "tf-matcher") continue;
        CHECK(!t.second.empty());
        CHECK(std::find(t.second.begin(), t.second.end(), allowed.back()) == t.second.end());
      }
    }
    stop(server);
  }

  { // --pin-core picks the core
    int core = allowed.front();
    pid_t server = start_server(exe, port, dir + "/c.wal", {"--pin-core", std::to_string(core)});
    CHECK(wait_for_port(port));
    auto threads = thread_cpus(server);
    auto m = threads.find("tf-matcher");
    CHECK(m != threads.end());
    if (m != threads.end()) CHECK((m->second == std::vector<int>{core}));
    stop(server);
  }

  { // a core this process may not use is an error, not a silent no-op
    pid_t server = start_server(exe, port, dir + "/d.wal", {"--pin-core", "100000"});
    int status = 0;
    waitpid(server, &status, 0);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) != 0);
  }

  std::string cmd = "rm -rf " + dir;
  if (std::system(cmd.c_str()) != 0) std::fprintf(stderr, "could not remove %s\n", dir.c_str());
}
#endif

int main(int argc, char **argv) {
  test_plan();
#ifdef __linux__
  if (argc < 2) {
    std::fprintf(stderr, "usage: pinning_test <engine_server>\n");
    return 2;
  }
  test_server(argv[1]);
#else
  (void)argc;
  (void)argv;
  std::printf("  not Linux: server part skipped\n");
#endif
  return finish("pinning_test");
}
