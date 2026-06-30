# `bsc-agent-sandbox` — the sealed WSL2 agent filesystem

The purpose-built, **model-agnostic** sandbox that isolated sessions run inside (#1988, part of the
Layer-4 runtime #1982 / the permission model #1916).

## Why this exists

Agents run with auto-approval for speed (the deny-list posture). The hooks
(`bsc-deny`/`bsc-confine`/`bsc-scope`) confine the agent's *tools*, but raw shell commands are the one
thing a hook can't fully contain. Claude Code ships an OS sandbox for that — but it only protects
**Claude** sessions, which doesn't fit a platform that runs **any** LLM (`bsc-agent` on
OpenAI/Gemini/local).

The model-agnostic answer is to make the **environment** the cage: a **sealed WSL2 distro**. Whatever
runs inside — Claude Code or `bsc-agent` on any model — is confined by the distro, because the seal
lives in `/etc/wsl.conf`, not in the agent runtime.

## What "sealed" means

`wsl.conf` (baked into the image) turns off the two things that would otherwise make WSL2 *not* a
sandbox:

| Setting | Effect |
|---|---|
| `automount.enabled = false` | **No `/mnt/c`.** The Windows drive is unreachable — no path to your files, SSH keys, or anything outside the distro. |
| `interop.enabled = false` | **No interop.** A process here can't exec `powershell.exe` / any Windows binary to climb back out. |
| `user.default = agent` | Never root by default. |

So the distro *is* the boundary, from first boot.

## Building it

### Self-contained (recommended) — no pre-staged binaries

`Dockerfile.build` compiles the slim Linux sidecars itself, then assembles the sealed rootfs. Run it
from the **repo root**:

```bash
docker build -f tooling/wsl-sandbox/Dockerfile.build -t bsc-agent-sandbox .
cid=$(docker create bsc-agent-sandbox)
docker export "$cid" -o "$HOME/.base-studio-code/wsl/bsc-agent-sandbox.tar"
docker rm "$cid"
wsl --import bsc-agent-sandbox "$HOME/.base-studio-code/wsl/bsc-agent-sandbox" \
    "$HOME/.base-studio-code/wsl/bsc-agent-sandbox.tar" --version 2
```

> **Verified** on Windows + docker-desktop: ~205 MB tarball; after import, inside the distro `ls /mnt/c`
> → *No such file or directory*, `powershell.exe` → *command not found*, and `bsc` / `bsc-agent` run as
> the non-root `agent` user. The cage holds.

### From pre-staged binaries (`build-rootfs.sh`)

Requires Docker (docker-desktop is fine) and the slim Linux sidecars in `./bin/`.

1. **Get the Linux sidecars.** The unified `bsc` is built **without** the `data` feature (DuckDB is
   `optional = true`), so it's small and easy to cross-build while keeping `bsc plan` / `bsc skill` /
   `bsc logs`:
   ```bash
   cargo build --release -p bsc --no-default-features --target x86_64-unknown-linux-gnu
   cargo build --release -p bsc-agent              --target x86_64-unknown-linux-gnu
   ```
   (or pull them from the CI Linux artifact — CI already builds the workspace on `ubuntu`). Copy the
   resulting `bsc` and `bsc-agent` into `tooling/wsl-sandbox/bin/`.
2. **Build the rootfs:**
   ```bash
   ./build-rootfs.sh            # → agent-sandbox.tar
   ```

## Importing + verifying the seal

```bash
wsl --import bsc-agent-sandbox "$HOME/.base-studio-code/wsl/bsc-agent-sandbox" agent-sandbox.tar --version 2

# the seal — both should FAIL / be empty:
wsl -d bsc-agent-sandbox -- ls /mnt/c          # → no such file or directory
wsl -d bsc-agent-sandbox -- powershell.exe     # → command not found
```

In the app, the **provision** command (`provision_sandbox`) runs the `wsl --import` step for the user;
readiness is reported by `wsl_sandbox_status` (#1984).

## Status

This is **Phase 0** of #1988 — the filesystem definition + the provision/import path. The launch
rewiring that actually spawns the planner + triage sessions *into* this distro (path translation, the
hub/worktrees on its ext4) is the next phase, and needs a real WSL2 box to validate.
