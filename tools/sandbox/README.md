# `tools/sandbox` — the executable spec for kernel-backed agent isolation

These are the Phase 0 artifacts, landed so that the Rust launcher in
`phase-2-kernel-isolation-replaces-the-hook-floor` slice 2 is written against something that
**already demonstrably works**, rather than against prose.

They are diagnostics, not app code. Nothing in the app calls them. Run them by hand on a Linux
host (or in WSL) when changing the isolation model, and when bringing up a new host.

## Why they exist

`bsc-confine`, `bsc-scope` and `bsc-deny` are **PreToolUse hooks** — see
`src-tauri/src/console/shell_rc/mod.rs`. A hook reads the *declared* tool payload and returns
before the command runs, so it can see `Bash("python3 build.py")` and nothing that `build.py`
then does:

```
Read("/etc/passwd")        -> hook sees the path          BLOCKED
Bash("cat /etc/passwd")    -> bsc-deny sees the string    BLOCKED
Bash("python3 build.py")   -> bsc-deny sees the command
   build.py: open("../../other-agent/worktree/...")
                           -> nothing in the chain sees it   ESCAPES
```

That is not a code-quality problem — the **enforcement point is wrong by construction**. Mount
namespaces are inherited by every descendant process. Hooks are not.

`namespace-escape.sh` exists to keep that claim honest: it reproduces the escape *first*, so a
green run means the hole was real and then closed, not that the fixture was broken.

## The scripts

| file | proves |
|---|---|
| `namespace-escape.sh` | the subprocess escape reproduces unsandboxed, and returns `ENOENT` inside a mount namespace; PID/net namespaces isolate; the store surface mounts read-only |
| `cgroup-caps.sh` | per-agent memory and task caps are enforced by the kernel, in isolation *and* stacked with the namespace, without breaking a workload that fits |
| `webkit-probe.c` + `.html` | whether the engine Tauri uses on Linux (webkit2gtk-4.1, **not** Chromium) gives us WebGL2 with instanced drawing — the foundation of the graph renderer |

## Running them

```bash
bash tools/sandbox/namespace-escape.sh      # needs: bubblewrap, python3
bash tools/sandbox/cgroup-caps.sh           # needs: systemd (cgroups v2 delegation), bubblewrap, python3

gcc -o /tmp/webkit-probe tools/sandbox/webkit-probe.c \
    $(pkg-config --cflags --libs webkit2gtk-4.1 gtk+-3.0)
/tmp/webkit-probe file://$PWD/tools/sandbox/webkit-probe.html
```

Both shell scripts confine themselves to `$HOME/.cache/bsc-sandbox-probe` and remove only that
directory. The guard test asserts this, because they do use `rm -rf`.

## Results recorded on Debian 13 trixie, kernel 6.6.87 (WSL2)

All thirteen checks passed. Full numbers live on the plan item
`phase-0-linux-port-viability`; the headline is `T1 LEAKED` -> `T2 BLOCKED, ENOENT`, PID
namespace 74 host processes -> 2, and 512 MB killed at `MemoryMax=128M` while 64 MB ran fine.

## Two traps worth knowing before you trust a run

**A workload can be "contained" for the wrong reason.** The first version of the stacked
cgroup+namespace test passed while actually failing: it passed a *host* path to a script that the
namespace correctly hid, so the run died with `ENOENT` and was scored as the memory cap firing.
The fixture now copies the script into the agent's own worktree so the cap is the only thing that
can kill it. If you add a case here, make sure it can only pass for the reason you claim.

**`webkit-probe` cannot tell you whether rendering is hardware accelerated.** WebKit deliberately
spoofs the renderer string — it reports `Apple Inc.` / `Apple GPU` on Linux as fingerprinting
resistance. Check for `/dev/dri` and whether WSLg prefixes the window title with `[WARN:COPY MODE]`
instead. Capability answers from this probe are trustworthy; performance answers are not.
