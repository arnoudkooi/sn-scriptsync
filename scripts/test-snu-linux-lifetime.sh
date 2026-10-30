#!/usr/bin/env bash
# Preserves the Linux session-lifetime release check first run for snu 0.6.3.
# A starts a detached bridge, B attaches, A's process group is terminated,
# the same bridge must answer another process, then stop and remove its files.
# Run only in a disposable Docker container; see packages/snu/README.md.
set -euo pipefail

if [[ "$(uname -s)" != Linux || ! -f /.dockerenv ]]; then
  echo 'Run this check in a disposable Linux Docker container (see packages/snu/README.md).' >&2
  exit 2
fi

set -m # Give each background MCP session its own process group.
snu_package_dir=$(cd "${1:-/app}" && pwd)
snu=(node "$snu_package_dir/bin/snu.js")
test_root=$(mktemp -d /tmp/snu-linux-lifetime.XXXXXX)
port_file=$(node -p 'require("path").join(require("os").homedir(), ".sn-scriptsync", "agent-port.json")')
session_a=''
session_b=''
bridge_pid=''
export SNU_DISABLE_UPDATE_CHECK=1
export CI=1

cleanup() {
  local result=$?
  trap - EXIT
  if [[ "$result" != 0 ]]; then
    for log in "$test_root/a.err" "$test_root/b.err" "$(dirname "$port_file")/snu-bridge.log"; do
      if [[ -f "$log" ]]; then
        printf '\n%s\n' "$log" >&2
        cat "$log" >&2
      fi
    done
  fi
  # Only processes launched by this check are eligible for cleanup.
  for pid in "$session_a" "$session_b"; do
    if [[ -n "$pid" ]]; then
      kill -TERM -- "-$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  exec 3>&- 4>&-
  if [[ -n "$bridge_pid" ]]; then
    kill -TERM "$bridge_pid" 2>/dev/null || true
  fi
  rm -rf "$test_root"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fail() { echo "FAIL: $*" >&2; exit 1; }

[[ -z "${SNU_MCP_BRIDGE:-}" && -z "${SNU_DETACHED_CHILD:-}" ]] || fail 'test requires the default bridge environment'
cd "$snu_package_dir"
"${snu[@]}" status --json | node -e 'if (JSON.parse(require("fs").readFileSync(0, "utf8")).running !== false) process.exit(1)' || fail 'a bridge was already running'
mkdir "$test_root/wsA" "$test_root/wsB"
mkfifo "$test_root/fa" "$test_root/fb"

(cd "$test_root/wsA" && exec "${snu[@]}" --mcp < "$test_root/fa" > "$test_root/a.out" 2> "$test_root/a.err") &
session_a=$!
exec 3>"$test_root/fa"
for ((i = 0; i < 100; i++)); do
  if grep -q 'Connected on stdio' "$test_root/a.err"; then break; fi
  sleep 0.1
done
grep -q 'Connected on stdio' "$test_root/a.err" || fail 'session A did not connect'
grep -q 'Started a detached standalone bridge' "$test_root/a.err" || fail 'session A did not start a detached bridge'
bridge_pid=$("${snu[@]}" status --json | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).pid || ""')
[[ "$bridge_pid" =~ ^[0-9]+$ && "$bridge_pid" != "$session_a" ]] || fail "bridge PID '$bridge_pid' is not separate from A ($session_a)"
echo "A=$session_a bridge=$bridge_pid"

(cd "$test_root/wsB" && exec "${snu[@]}" --mcp < "$test_root/fb" > "$test_root/b.out" 2> "$test_root/b.err") &
session_b=$!
exec 4>"$test_root/fb"
for ((i = 0; i < 100; i++)); do
  if grep -q 'Connected on stdio' "$test_root/b.err"; then break; fi
  sleep 0.1
done
grep -q 'Connected on stdio' "$test_root/b.err" || fail 'session B did not connect'
grep -q "Attached to the bridge registered on port .* (PID $bridge_pid)" "$test_root/b.err" || fail "session B did not attach to $bridge_pid"
echo "B=$session_b attached to $bridge_pid"

kill -TERM -- "-$session_a"
exec 3>&-
wait "$session_a" 2>/dev/null || true
sleep 1
if kill -0 "$session_a" 2>/dev/null; then fail 'session A is still alive'; fi
session_a=''
kill -0 "$bridge_pid" || fail 'bridge died with session A'
kill -0 "$session_b" || fail 'session B died with session A'
echo "Session A's process group was terminated; bridge $bridge_pid and session B survived"

(cd "$test_root/wsB" && "${snu[@]}" negotiate --json) > "$test_root/negotiate.json" || fail 'negotiate from another process failed'
current_pid=$("${snu[@]}" status --json | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).pid || ""')
[[ "$current_pid" = "$bridge_pid" ]] || fail "bridge changed from $bridge_pid to $current_pid"

"${snu[@]}" stop --json || fail 'snu stop failed'
sleep 0.5
if kill -0 "$bridge_pid" 2>/dev/null; then fail 'bridge is still alive after snu stop'; fi
bridge_pid=''
[[ ! -e "$port_file" ]] || fail 'global port file was left behind'
"${snu[@]}" status --json | node -e 'if (JSON.parse(require("fs").readFileSync(0, "utf8")).running !== false) process.exit(1)' || fail 'status still reports running'
echo 'PASS: bridge outlived its session, served another process, and stopped cleanly'
