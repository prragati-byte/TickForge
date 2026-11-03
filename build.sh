#!/usr/bin/env bash
# TickForge: one script to build, test, benchmark and run everything.
#
#   ./build.sh          check tools, build everything, start the stack (Ctrl+C stops it)
#   ./build.sh test     run every test suite
#   ./build.sh bench    run the benchmarks and write docs/BENCHMARKS.md
#   ./build.sh bench-mysql   TickForge database vs MySQL; writes docs/benchmarks/mysql.md
#   ./build.sh kill9 [engine flags]   crash check: kill -9 the engine, compare state hashes
#   ./build.sh clean    delete build output, .venv, node_modules and runtime data
#
# Linux and macOS (on Windows, use WSL2). Nothing here uses sudo or installs anything
# outside this folder: if a tool is missing, the script prints the command to install it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$ROOT/.run"
LOGS="$RUN/logs"
DATA="$RUN/data"
STAMPS="$RUN/stamps"
ENGINE_BUILD="$RUN/build/engine"
VENV="$ROOT/.venv"
PY="$VENV/bin/python"

# Ports (see docs/CONTRACTS.md section 7)
ENGINE_PORT=9100
API_PORT=8001
MARKET_PORT=8000
WEB_PORT=8443

MATURIN_VERSION="1.16.0"
OS="$(uname -s)"

# ---- small helpers --------------------------------------------------------------------------------
say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

cpu_count() { nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2; }

# version_ge 3.14.4 3.10  -> true when the first is at least the second
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]; }

# Hash of some files, used to skip steps whose inputs did not change.
hash_files() { cat "$@" | cksum | cut -d' ' -f1; }

# changed NAME FILE...  -> true if the files differ from the last time mark_done NAME ran
changed() {
  local name="$1"; shift
  [ "$(cat "$STAMPS/$name" 2>/dev/null || true)" != "$(hash_files "$@")" ]
}
mark_done() {
  local name="$1"; shift
  mkdir -p "$STAMPS"
  hash_files "$@" > "$STAMPS/$name"
}

# run_logged NAME CMD...  -> run a command, keep its output in .run/logs/NAME.log, show the end on failure
run_logged() {
  local name="$1"; shift
  mkdir -p "$LOGS"
  if ! "$@" > "$LOGS/$name.log" 2>&1; then
    tail -n 30 "$LOGS/$name.log" >&2
    fail "'$name' failed. Full output: $LOGS/$name.log"
  fi
}

# ---- tools ----------------------------------------------------------------------------------------
MISSING=()

# need_tool COMMAND MIN_VERSION VERSION_COMMAND INSTALL_HINT
need_tool() {
  local cmd="$1" min="$2" version_cmd="$3" hint="$4"
  if ! command -v "$cmd" > /dev/null 2>&1; then
    MISSING+=("$cmd is missing. Install it with:  $hint")
    return
  fi
  if [ -n "$min" ]; then
    local have
    have="$(eval "$version_cmd" 2>/dev/null | head -n 1 | grep -Eo '[0-9]+(\.[0-9]+)+' | head -n 1 || true)"
    if [ -z "$have" ] || ! version_ge "$have" "$min"; then
      MISSING+=("$cmd $min or newer is needed (found ${have:-unknown}). Install it with:  $hint")
    fi
  fi
}

check_tools() {
  say "Checking tools"
  MISSING=()
  if [ "$OS" = "Darwin" ]; then
    need_tool python3 3.10 "python3 --version" "brew install python"
    need_tool node 20 "node --version" "brew install node"
    need_tool npm "" "" "brew install node"
    need_tool cmake 3.20 "cmake --version" "brew install cmake"
    need_tool c++ "" "" "xcode-select --install"
    need_tool curl "" "" "brew install curl"
  else
    need_tool python3 3.10 "python3 --version" "sudo apt install python3 python3-venv python3-pip"
    need_tool node 20 "node --version" "sudo apt install nodejs npm   (or use https://github.com/nvm-sh/nvm)"
    need_tool npm "" "" "sudo apt install npm"
    need_tool cmake 3.20 "cmake --version" "sudo apt install cmake"
    need_tool c++ "" "" "sudo apt install g++"
    need_tool curl "" "" "sudo apt install curl"
  fi
  need_tool cargo 1.75 "cargo --version" "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  if command -v python3 > /dev/null 2>&1 && ! python3 -c "import venv, ensurepip" > /dev/null 2>&1; then
    MISSING+=("python3 cannot create virtual environments. Install it with:  sudo apt install python3-venv")
  fi
  if [ "${#MISSING[@]}" -gt 0 ]; then
    printf '%s\n' "${MISSING[@]}" >&2
    fail "install the tools above and run ./build.sh again."
  fi
  echo "all tools found"
}

# ---- build steps ----------------------------------------------------------------------------------
setup_python() {
  say "Python environment (.venv)"
  [ -x "$PY" ] || python3 -m venv "$VENV"
  local files=("$ROOT/services/exchange-api/requirements.txt" "$ROOT/services/market-data/requirements.txt")
  if changed pip "${files[@]}" || [ ! -x "$VENV/bin/maturin" ]; then
    run_logged pip "$PY" -m pip install --quiet --upgrade pip
    run_logged pip "$PY" -m pip install --quiet "maturin==$MATURIN_VERSION" \
      -r "${files[0]}" -r "${files[1]}"
    mark_done pip "${files[@]}"
  else
    echo "up to date"
  fi
}

build_database() {
  say "Rust database (tickforge_db) into .venv"
  # maturin installs into the active virtual environment
  ( cd "$ROOT/storage" && VIRTUAL_ENV="$VENV" PATH="$VENV/bin:$PATH" run_logged storage-build maturin develop --release )
  "$PY" -c "from tickforge_db import TickForgeDB" || fail "tickforge_db did not install into .venv"
  echo "tickforge_db ready"
}

# build_engine [TYPE [DIR]]  -> Release into .run/build/engine unless told otherwise
build_engine() {
  local build_type="${1:-Release}" dir="${2:-$ENGINE_BUILD}"
  say "C++ engine ($build_type)"
  run_logged engine-configure cmake -S "$ROOT/engine" -B "$dir" -DCMAKE_BUILD_TYPE="$build_type"
  run_logged engine-build cmake --build "$dir" -j "$(cpu_count)"
  echo "built in $dir"
}

install_frontend() {
  say "Frontend packages"
  if changed npm "$ROOT/frontend/package-lock.json" || [ ! -d "$ROOT/frontend/node_modules" ]; then
    ( cd "$ROOT/frontend" && run_logged npm-ci npm ci --no-audit --no-fund )
    mark_done npm "$ROOT/frontend/package-lock.json"
  else
    echo "up to date"
  fi
}

# ---- running the stack ----------------------------------------------------------------------------
PIDS=()

kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$pid" 2> /dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  if [ "${#PIDS[@]}" -gt 0 ]; then
    echo
    echo "Stopping TickForge..."
    for pid in "${PIDS[@]}"; do kill_tree "$pid"; done
    wait 2> /dev/null || true
  fi
  rm -f "$RUN/build.pid"
}

port_open() { (exec 3<> "/dev/tcp/127.0.0.1/$1") 2> /dev/null; }
http_ok() { curl -fsS --max-time 2 "$1" > /dev/null 2>&1; }

# start NAME DIR CMD...  -> run in the background, log to .run/logs/NAME.log
start() {
  local name="$1" dir="$2"; shift 2
  ( cd "$dir" && exec "$@" ) > "$LOGS/$name.log" 2>&1 &
  PIDS+=("$!")
  LAST_PID=$!
}

# wait_until NAME PID CHECK_CMD...  -> poll until the check passes; stop early if the process died
wait_until() {
  local name="$1" pid="$2"; shift 2
  local tries=0
  until "$@"; do
    if ! kill -0 "$pid" 2> /dev/null; then
      tail -n 20 "$LOGS/$name.log" >&2
      fail "$name stopped while starting. Log: $LOGS/$name.log"
    fi
    tries=$((tries + 1))
    [ "$tries" -le 300 ] || fail "$name did not become ready in 60 seconds. Log: $LOGS/$name.log"
    sleep 0.2
  done
}

run_stack() {
  mkdir -p "$LOGS" "$DATA"

  if [ -f "$RUN/build.pid" ] && kill -0 "$(cat "$RUN/build.pid")" 2> /dev/null; then
    fail "TickForge is already running (started by process $(cat "$RUN/build.pid")). Press Ctrl+C in that terminal first."
  fi
  for port in "$ENGINE_PORT" "$API_PORT" "$MARKET_PORT" "$WEB_PORT"; do
    if port_open "$port"; then fail "port $port is already in use. Stop whatever is using it and run ./build.sh again."; fi
  done
  echo $$ > "$RUN/build.pid"
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  say "Starting"
  # TICKFORGE_ENGINE_FLAGS adds engine options, for example "--pin".
  # shellcheck disable=SC2086
  start engine "$ROOT" "$ENGINE_BUILD/engine_server" --port "$ENGINE_PORT" --wal "$DATA/engine.wal" ${TICKFORGE_ENGINE_FLAGS:-}
  wait_until engine "$LAST_PID" port_open "$ENGINE_PORT"
  echo "engine          127.0.0.1:$ENGINE_PORT"

  start exchange-api "$ROOT/services/exchange-api" env \
    TICKFORGE_ENGINE_PORT="$ENGINE_PORT" TICKFORGE_DATA_DIR="$DATA" \
    "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$API_PORT"
  wait_until exchange-api "$LAST_PID" http_ok "http://127.0.0.1:$API_PORT/health"
  echo "exchange-api    http://127.0.0.1:$API_PORT"

  start market-data "$ROOT/services/market-data" "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$MARKET_PORT"
  wait_until market-data "$LAST_PID" http_ok "http://127.0.0.1:$MARKET_PORT/hello"
  echo "market-data     http://127.0.0.1:$MARKET_PORT"

  start frontend "$ROOT/frontend" env PORT="$WEB_PORT" npm run dev
  wait_until frontend "$LAST_PID" http_ok "http://127.0.0.1:$WEB_PORT/"
  echo "frontend        http://127.0.0.1:$WEB_PORT"

  cat <<EOF

TickForge is running.

  Open the dashboard:  http://localhost:$WEB_PORT
  API documentation:   http://127.0.0.1:$API_PORT/docs
  Logs:                $LOGS

Press Ctrl+C to stop everything.
EOF

  # Stay alive; if any part dies, say so and stop the rest.
  while true; do
    for pid in "${PIDS[@]}"; do
      kill -0 "$pid" 2> /dev/null || fail "a TickForge process stopped (pid $pid). Check the logs in $LOGS"
    done
    sleep 1
  done
}

# ---- test -----------------------------------------------------------------------------------------
FAILED=()

# step NAME CMD...  -> run a check, remember if it failed, keep going
step() {
  local name="$1"; shift
  say "$name"
  if "$@"; then echo "PASS: $name"; else echo "FAIL: $name"; FAILED+=("$name"); fi
}

engine_tests() {
  build_engine Debug "$RUN/build/engine-test" && ctest --test-dir "$RUN/build/engine-test" --output-on-failure
}

do_test() {
  check_tools
  setup_python
  install_frontend
  build_database
  # ctest includes the WAL crash tests, the kill -9 recovery test and the queue stress test
  # under ThreadSanitizer and AddressSanitizer.
  step "C++ engine tests (ctest)" engine_tests
  step "Rust tests (cargo test)" bash -c "cd '$ROOT/storage' && cargo test"
  step "database Python binding" "$PY" -m unittest discover -s "$ROOT/storage/tests" -p 'test_python.py'
  step "exchange-api tests (pytest)" bash -c "cd '$ROOT/services/exchange-api' && '$PY' -m pytest -q"
  step "market-data tests (pytest)" bash -c "cd '$ROOT/services/market-data' && '$PY' -m pytest -q"
  step "frontend typecheck" bash -c "cd '$ROOT/frontend' && npm run typecheck"
  step "frontend tests (vitest)" bash -c "cd '$ROOT/frontend' && npm test"
  if [ "${#FAILED[@]}" -gt 0 ]; then
    printf '\nFailed:\n'; printf '  %s\n' "${FAILED[@]}"
    exit 1
  fi
  printf '\nAll test suites passed.\n'
}

# ---- bench ----------------------------------------------------------------------------------------
cpu_model() {
  grep -m1 'model name' /proc/cpuinfo 2> /dev/null | cut -d: -f2- | sed 's/^ *//' \
    || sysctl -n machdep.cpu.brand_string 2> /dev/null || echo unknown
}
memory() {
  if [ -r /proc/meminfo ]; then awk '/MemTotal/ {printf "%.1f GiB", $2 / 1048576}' /proc/meminfo
  else sysctl -n hw.memsize 2> /dev/null | awk '{printf "%.1f GiB", $1 / 1073741824}'; fi
}

do_bench() {
  check_tools
  build_engine Release
  local bin="$ENGINE_BUILD/engine_bench"
  [ -x "$bin" ] || fail "$bin was not built. The engine's CMake project must define an 'engine_bench' executable."

  say "Running benchmarks (this takes several minutes)"
  local out="$LOGS/bench-output.md"
  mkdir -p "$LOGS"
  "$bin" | tee "$out"
  server_benchmarks | tee -a "$out"

  local file="$ROOT/docs/BENCHMARKS.md"
  {
    echo "# Benchmarks"
    echo
    echo "Written by \`./build.sh bench\`. The numbers below are the engine benchmark's own output,"
    echo "measured on the machine described here; they will differ on other machines."
    echo
    echo "## Machine"
    echo
    echo "| | |"
    echo "|---|---|"
    echo "| Date (UTC) | $(date -u '+%Y-%m-%d %H:%M') |"
    echo "| CPU | $(cpu_model) |"
    echo "| Logical cores | $(cpu_count) |"
    echo "| Memory | $(memory) |"
    echo "| OS | $(uname -sr) |"
    echo "| Compiler | $(c++ --version | head -n 1) |"
    echo "| Build type | Release |"
    echo "| Source commit | $(git -C "$ROOT" rev-parse --short HEAD 2> /dev/null || echo unknown) |"
    echo
    echo "## Results"
    echo
    cat "$out"
    if [ -f "$ROOT/docs/benchmarks/mysql.md" ]; then
      echo
      cat "$ROOT/docs/benchmarks/mysql.md"
    fi
  } > "$file"
  echo "Wrote $file"
}

# Same server, different flags, same load. WAL files go on the real disk (.run), not /tmp.
server_benchmarks() {
  local dir="$RUN/bench" exe="$ENGINE_BUILD/engine_server"
  mkdir -p "$dir"
  local sb=("$ENGINE_BUILD/server_bench" --server "$exe" --dir "$dir")
  echo "## Whole server, by engine flag"
  echo
  echo "Measured over TCP by \`engine/bench/server_bench.cpp\`. RTT is send to ack. The matcher columns are"
  echo "the server's own numbers, from queue push to matching finished; they show a backlog when the load is"
  echo "more than the matching thread can take."
  echo
  echo "### Core pinning"
  echo
  "${sb[@]}" --conns 4 --orders 30000 --rate 2000 --runs 15 --config "unpinned=--no-pin" --config "pinned=--pin"
  echo
  "${sb[@]}" --conns 4 --orders 200000 --runs 7 --config "unpinned=--no-pin" --config "pinned=--pin"
  echo
}

# ---- MySQL baseline -------------------------------------------------------------------------------
do_bench_mysql() {
  check_tools
  say "Building the MySQL baseline"
  run_logged mysql-bench-build cargo build --release --manifest-path "$ROOT/bench/mysql_baseline/Cargo.toml" \
    --target-dir "$RUN/build/mysql-bench"
  say "Running it (about 15 minutes)"
  python3 "$ROOT/bench/mysql_baseline/run.py"
  echo "Run ./build.sh bench to include these results in docs/BENCHMARKS.md."
}

# ---- crash check ----------------------------------------------------------------------------------
do_kill9() {
  check_tools
  build_engine Release
  say "kill -9 recovery check"
  python3 "$ROOT/engine/tools/kill9_check.py" "$ENGINE_BUILD/engine_server" "$RUN/kill9" "$@"
}

# ---- clean ----------------------------------------------------------------------------------------
do_clean() {
  say "Cleaning"
  rm -rf "$RUN" "$VENV" "$ROOT/frontend/node_modules" "$ROOT/frontend/dist" "$ROOT/storage/target"
  find "$ROOT/services" -name __pycache__ -type d -prune -exec rm -rf {} + 2> /dev/null || true
  find "$ROOT/services" -name .pytest_cache -type d -prune -exec rm -rf {} + 2> /dev/null || true
  echo "removed .run, .venv, node_modules, build output"
}

# ---- main -----------------------------------------------------------------------------------------
case "${1:-run}" in
  run)
    check_tools
    setup_python
    build_database
    build_engine Release
    install_frontend
    run_stack
    ;;
  test) do_test ;;
  bench) do_bench ;;
  bench-mysql) do_bench_mysql ;;
  kill9) shift; do_kill9 "$@" ;;
  clean) do_clean ;;
  -h | --help | help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *) fail "unknown mode '$1'. Use: ./build.sh [test|bench|bench-mysql|kill9|clean]" ;;
esac
