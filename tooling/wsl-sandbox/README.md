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

## What's inside (#4260)

The cage has to host **every** harness, not just `bsc-agent` — Claude Code is the default one, and `gh`
is the director's entire GitHub surface. So the rootfs bakes in:

| | why |
|---|---|
| `git`, `openssh-client`, `ca-certificates`, `curl` | worktrees, remotes, HTTPS |
| `bsc`, `bsc-agent` | the slim Linux sidecars (`bsc` without the DuckDB `data` feature) |
| **Node + `@anthropic-ai/claude-code`** | the DEFAULT harness. Without it the sandbox could only run `bsc-agent`, which is why it stayed opt-in |
| **`gh`** (GitHub's signed apt repo) | the director's GitHub writes + every session's readiness probe (#297 S1) |

## Per-agent isolation layout (#1994 / #4260)

Each fleet session runs as its own `bsc-<slug>-<hash>` Linux user, provisioned at launch by
`ensure_sandbox_user`. The split is **private code, shared agreement**:

```
/home/<bsc-user>/                 700 — unreadable to every other agent
  worktrees/<key>/<repo>--<slug>  the agent's OWN checkout (created BY it)
  .base-studio-code -> /srv/bsc-shared/base
/srv/bsc-shared/                  2770 root:bsc-agents, setgid
  base/projects/<key>/            the hub: plan.db, sections, prompts
  base/projects/<key>/<repo>/     ONE git object store per repo (core.sharedRepository=group)
  base/…                          coord.log + the global bsc stores
```

> **Why the worktree location is load-bearing.** Every hub, clone and worktree used to live under
> `/home/agent` — mode `700`, owned by the *default* user — while the session ran as `bsc-…`. A worker
> could not `cd` into its own worktree (`Permission denied`, verified on a live distro), so per-agent
> users could never be switched on. The worktree has to be in its owner's home.

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

The filesystem definition, the provision/import path, and the launch rewiring (sessions spawn *into*
the distro, with the hub + worktrees on its ext4) are all built. #4260 added the agent runtimes and
made per-agent Linux users actually usable.

**Still opt-in.** Making the sandbox the *only* posture needs a delivery route for the rootfs:
`provision_sandbox` requires the tarball to be staged at
`~/.base-studio-code/wsl/bsc-agent-sandbox.tar` by a hand-run Docker build. Failing closed before that
exists would mean no agent can launch on a machine without Docker.

Measured, with the runtimes baked in: **~730 MB** exported (from ~205 MB before; Claude Code alone is
~260 MB after the musl prune). That is too heavy to bundle into the installer, so the likely route is
fetching it on first provision from a release asset — see #4260.
