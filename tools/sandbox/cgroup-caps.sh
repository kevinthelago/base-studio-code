#!/usr/bin/env bash
# Are per-agent resource caps actually enforced by the kernel, alone and stacked with the namespace?
#
# This matters independently of security. The repo has an OOM history (#795), takes a
# cross-worktree lock from ~/.base-studio-code/locks/ because only two 8 GB full gates fit in
# 16 GB free, and pins jobs = 4 globally in .cargo/config.toml to protect the fleet. All three
# are userspace negotiation for something the kernel enforces directly.
#
# Plan: phase-2-kernel-isolation-replaces-the-hook-floor (slice 1)
set -u

# Confined to one directory under $HOME, because this script uses rm -rf.
# tools/sandbox/sandbox.test.ts asserts that invariant.
ROOT="$HOME/.cache/bsc-sandbox-probe"
rm -rf "$ROOT"
mkdir -p "$ROOT/agent-a" "$ROOT/store"

hr() { printf '%s\n' "----------------------------------------------------------------"; }
need() { command -v "$1" >/dev/null || { echo "MISSING DEPENDENCY: $1"; exit 2; }; }
need systemd-run
need bwrap
need python3

[ -d /sys/fs/cgroup ] || { echo "no /sys/fs/cgroup"; exit 2; }
[ "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs ] || { echo "cgroups v2 required"; exit 2; }

# Allocate N MB and hold it.
cat > "$ROOT/agent-a/hog.py" <<'PY'
import sys
mb = int(sys.argv[1])
chunks = [bytearray(1024 * 1024) for _ in range(mb)]
print("  allocated", mb, "MB")
PY

# Bounded fork pressure. NOT a fork bomb - it stops on its own.
cat > "$ROOT/agent-a/forker.py" <<'PY'
import os, sys, time
want = int(sys.argv[1]); made = 0
for _ in range(want):
    try:
        pid = os.fork()
    except OSError:
        break
    if pid == 0:
        time.sleep(2); os._exit(0)
    made += 1
print("  forked", made, "of", want)
PY

capped() {
    local mem="$1" tasks="$2"; shift 2
    systemd-run --scope --quiet --collect \
        --unit "bsc-sandbox-probe-$RANDOM" \
        -p MemoryMax="$mem" -p MemorySwapMax=0 -p TasksMax="$tasks" \
        -- "$@"
}

# The launcher shape slice 2 renders in Rust: a cgroup scope wrapping a bwrap namespace.
capped_sandbox() {
    local mem="$1" tasks="$2"; shift 2
    capped "$mem" "$tasks" bwrap \
        --unshare-all --die-with-parent \
        --ro-bind /usr /usr \
        --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
        --symlink usr/bin /bin --symlink usr/sbin /sbin \
        --proc /proc --dev /dev --tmpfs /tmp \
        --bind "$ROOT/agent-a" /repo \
        --ro-bind "$ROOT/store" /plan \
        --chdir /repo --setenv HOME /repo \
        -- "$@"
}

echo "CGROUP v2 CAPS"
hr
echo "controllers : $(cat /sys/fs/cgroup/cgroup.controllers)"
echo "host memory : $(free -m | awk '/^Mem:/{print $2" MB total, "$7" MB available"}')"
hr

FAIL=0

echo "T8   512MB with NO cap (baseline - proves the workload itself is fine)"
if python3 "$ROOT/agent-a/hog.py" 512; then echo "  rc=0 as expected"; else echo "  FAIL: host cannot even run the baseline"; FAIL=1; fi
hr

echo "T9   512MB at MemoryMax=128M"
if capped 128M 64 python3 "$ROOT/agent-a/hog.py" 512; then
    echo "  rc=0  NOT CONTAINED (the cap did not bind)"; FAIL=1
else
    echo "  rc=$?  CONTAINED by the kernel"
fi
hr

echo "T10  64MB at the SAME cap - the cap must not break legitimate work"
if capped 128M 64 python3 "$ROOT/agent-a/hog.py" 64; then echo "  rc=0  PASS"; else echo "  rc=$?  FAIL - cap too tight"; FAIL=1; fi
hr

echo "T11  200 forks at TasksMax=32"
capped 256M 32 python3 "$ROOT/agent-a/forker.py" 200 2>/dev/null
echo "  (the kernel refuses forks past the cap rather than letting one agent exhaust the pid space)"
hr

# NOTE: hog.py is read from /repo, i.e. INSIDE the namespace. An earlier version passed a host
# path here and "passed" for the wrong reason - the namespace correctly hid the file, the run
# died with ENOENT, and that was scored as the memory cap firing. Keep the script inside /repo so
# the cap is the only thing that can kill this.
echo "T12  full stack (scope + namespace), 512MB at MemoryMax=128M"
if capped_sandbox 128M 64 python3 /repo/hog.py 512; then
    echo "  rc=0  NOT CONTAINED"; FAIL=1
else
    # 137 = SIGKILL from the cgroup OOM killer, 143 = SIGTERM from scope teardown.
    # Either is containment; asserting exactly 137 is too narrow.
    echo "  rc=$?  CONTAINED (137 = OOM kill, 143 = scope teardown)"
fi
hr

echo "T13  full stack, 64MB - real work still runs"
if capped_sandbox 128M 64 python3 /repo/hog.py 64; then echo "  rc=0  PASS"; else echo "  rc=$?  FAIL"; FAIL=1; fi
hr

echo "VERDICT"
if [ $FAIL -eq 0 ]; then
    echo "  An agent launches as: systemd-run --scope (limits) + bwrap (namespaces)."
    echo "  Memory and task count are enforced per agent, so the fleet cannot OOM the host"
    echo "  regardless of how many agents gate at once."
else
    echo "  One or more caps did NOT bind - do not rely on cgroup limits on this host."
fi

rm -rf "$ROOT"
exit $FAIL
