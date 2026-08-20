#!/usr/bin/env bash
# Does a kernel namespace close the subprocess escape that a PreToolUse hook cannot see?
#
# See tools/sandbox/README.md for why this exists. The short version: bsc-confine inspects the
# DECLARED tool payload and returns before the command runs, so a script spawned by Bash is
# invisible to it. A mount namespace is inherited by every descendant, so the same escape fails
# at the syscall instead.
#
# T1 reproduces the escape FIRST. That ordering is deliberate: a run where T2 passes but T1 never
# leaked proves nothing except that the fixture is broken.
#
# Plan: phase-2-kernel-isolation-replaces-the-hook-floor (slice 1)
set -u

# Confined to one directory under $HOME, because this script uses rm -rf.
# tools/sandbox/sandbox.test.ts asserts that invariant.
ROOT="$HOME/.cache/bsc-sandbox-probe"
rm -rf "$ROOT"
mkdir -p "$ROOT/agent-a" "$ROOT/agent-b" "$ROOT/store"

echo "SECRET-FROM-AGENT-B" > "$ROOT/agent-b/secret.txt"
echo "plan item 42: open" > "$ROOT/store/plan.txt"

# The escape vector is a SUBPROCESS - precisely what the hook cannot inspect.
cat > "$ROOT/agent-a/escape.py" <<'PY'
import sys, os
try:
    with open(sys.argv[1]) as f:
        print("  LEAKED  :", f.read().strip())
        sys.exit(0)
except OSError as e:
    print("  BLOCKED :", type(e).__name__, "errno", e.errno, os.strerror(e.errno))
    sys.exit(1)
PY

hr() { printf '%s\n' "----------------------------------------------------------------"; }

need() { command -v "$1" >/dev/null || { echo "MISSING DEPENDENCY: $1"; exit 2; }; }
need bwrap
need python3

echo "NAMESPACE ISOLATION"
hr
echo "kernel : $(uname -r)"
echo "bwrap  : $(bwrap --version 2>/dev/null)"
echo "cgroup : $(stat -fc %T /sys/fs/cgroup 2>/dev/null)"
hr

# Landlock ABI, if the headers are here. v3 gives filesystem rules; network rules need v4 (6.7+).
cat > "$ROOT/landlock_probe.c" <<'C'
#include <linux/landlock.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <stdio.h>
int main(void) {
    long abi = syscall(SYS_landlock_create_ruleset, NULL, 0,
                       LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 0) { printf("landlock: UNAVAILABLE\n"); return 1; }
    printf("landlock: ABI v%ld\n", abi);
    return 0;
}
C
if command -v gcc >/dev/null && gcc -o "$ROOT/landlock_probe" "$ROOT/landlock_probe.c" 2>/dev/null; then
    "$ROOT/landlock_probe"
else
    echo "landlock: not probed (no gcc or no linux/landlock.h)"
fi
hr

echo "T1  unsandboxed - the hook has already returned by now"
python3 "$ROOT/agent-a/escape.py" "$ROOT/agent-b/secret.txt"
T1=$?
hr

# The agent sandbox. agent-b is not DENIED - it is not in the namespace at all.
agent_sandbox() {
    bwrap \
        --unshare-all \
        --die-with-parent \
        --ro-bind /usr /usr \
        --symlink usr/lib /lib \
        --symlink usr/lib64 /lib64 \
        --symlink usr/bin /bin \
        --symlink usr/sbin /sbin \
        --proc /proc \
        --dev /dev \
        --tmpfs /tmp \
        --bind "$ROOT/agent-a" /repo \
        --ro-bind "$ROOT/store" /plan \
        --chdir /repo \
        --setenv HOME /repo \
        "$@"
}

echo "T2  the same subprocess, inside the namespace"
agent_sandbox python3 /repo/escape.py "$ROOT/agent-b/secret.txt"
T2=$?
hr

echo "T3  its own worktree is still reachable"
agent_sandbox python3 -c "print('  OK      :', open('/repo/escape.py').readline().strip()[:40])"
T3=$?

echo "T4  the store surface is readable at /plan"
agent_sandbox python3 -c "print('  OK      :', open('/plan/plan.txt').read().strip())"
T4=$?

echo "T5  the store surface is READ-ONLY"
if agent_sandbox sh -c 'echo tampered > /plan/plan.txt' 2>/dev/null; then
    echo "  WRITABLE: store was mutated (BAD)"; T5=1
else
    echo "  BLOCKED : read-only mount rejected the write"; T5=0
fi
hr

echo "T6  PID namespace"
echo "  host sees $(ps -e --no-headers 2>/dev/null | wc -l) processes; sandbox sees $(agent_sandbox ps -e --no-headers 2>/dev/null | wc -l)"
hr

echo "T7  network namespace"
agent_sandbox python3 -c "
import socket
socket.setdefaulttimeout(3)
try:
    socket.create_connection(('1.1.1.1', 53))
    print('  REACHED : network is up (BAD for a no-net role)')
except OSError as e:
    print('  BLOCKED :', type(e).__name__, '-', e)
"
hr

FAIL=0
echo "VERDICT"
if [ $T1 -eq 0 ]; then echo "  T1 escape reproduced unsandboxed .......... the hole is real"
else echo "  T1 DID NOT REPRODUCE - fixture is broken, ignore T2"; FAIL=1; fi
if [ $T2 -ne 0 ]; then echo "  T2 same escape blocked by the kernel ...... PASS"
else echo "  T2 escape SUCCEEDED inside the sandbox .... FAIL"; FAIL=1; fi
[ $T3 -eq 0 ] && echo "  T3 own worktree still usable .............. PASS" || { echo "  T3 FAIL"; FAIL=1; }
[ $T4 -eq 0 ] && echo "  T4 store surface readable ................. PASS" || { echo "  T4 FAIL"; FAIL=1; }
[ $T5 -eq 0 ] && echo "  T5 store surface read-only ................ PASS" || { echo "  T5 FAIL"; FAIL=1; }

rm -rf "$ROOT"
exit $FAIL
