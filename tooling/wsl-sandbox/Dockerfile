# The sealed, model-agnostic WSL2 agent sandbox rootfs (#1988 / #1982 / #1916 / #4260).
#
# A purpose-built Linux root filesystem that becomes a WSL2 distro (`bsc-agent-sandbox`). Whatever
# agent runtime runs *inside* it — Claude Code, or `bsc-agent` driving any LLM — is confined by the
# distro itself: the seal is baked into /etc/wsl.conf (no Windows mount, no interop), so the cage does
# not depend on the agent runtime cooperating. This is the model-agnostic answer to Claude Code's own
# (Claude-only) Bash sandbox.
#
# Model-agnostic means it hosts them ALL: Claude Code + `gh` are baked in alongside `bsc-agent`
# (#4260). While they weren't, the sandbox could only run the non-default harness, which is why it
# could never become the default posture.
#
# Build → tarball with ./build-rootfs.sh, then `wsl --import bsc-agent-sandbox <dir> agent-sandbox.tar`.
FROM debian:stable-slim

# The minimal toolchain a session needs: git for the worktrees, certs for HTTPS (git/gh/LLM APIs),
# ssh-client for git-over-ssh remotes, curl for the gh repo key. Everything else an agent brings or asks for.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git openssh-client procps \
    && rm -rf /var/lib/apt/lists/*

# THE AGENT RUNTIMES (#4260). The sandbox is the posture, not an opt-in — so the cage has to host
# EVERY harness, not just `bsc-agent`. Claude Code is the default one, so Node + the CLI are baked in;
# `gh` is what the director's entire GitHub surface (and every session's readiness probe, #297 S1) runs
# on. Leave these out and the distro can only host `bsc-agent`, and "one posture" is unreachable.
#
# The rootfs is something a user has to download, so weight is a feature: the claude-code package
# ships BOTH a glibc and a musl Linux build (~260 MB each). Debian is glibc, so the musl copy is dead
# weight — dropping it takes the image from ~986 MB to ~730 MB. Tolerant `rm` (a future package that
# stops shipping it just makes this a no-op).
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm \
    && npm install -g @anthropic-ai/claude-code \
    && rm -rf /usr/local/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-x64-musl \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

# `gh` is not in Debian main — install from GitHub's own signed apt repo (version-agnostic, so the
# image doesn't pin a release that ages out).
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Our slim Linux sidecars. The unified `bsc` is built WITHOUT the `data` feature (DuckDB is
# `optional = true`), so it carries `bsc plan` / `bsc skill` / `bsc logs` — everything a session
# needs — without the heavy C++ dep. Produced by CI / tooling (see README); dropped into ./bin first.
COPY bin/bsc /usr/local/bin/bsc
COPY bin/bsc-agent /usr/local/bin/bsc-agent
RUN chmod +x /usr/local/bin/bsc /usr/local/bin/bsc-agent

# The per-agent isolation skeleton (#1994/#4260). Every fleet session runs as its OWN `bsc-*` Linux
# user with a 700 home (provisioned at launch by `ensure_sandbox_user`), so one agent's worktree is
# unreadable to another even via raw Bash. What they must SHARE — the project hub, plan.db, coord.log,
# the global bsc stores, the git object store — lives in one setgid group dir instead, which every
# agent home reaches through a `~/.base-studio-code` symlink. Isolation therefore costs no coordination.
RUN groupadd bsc-agents \
    && useradd --create-home --shell /bin/bash -g bsc-agents agent \
    && chmod 700 /home/agent \
    && mkdir -p /srv/bsc-shared/base \
    && chgrp -R bsc-agents /srv/bsc-shared \
    && chmod 2770 /srv/bsc-shared /srv/bsc-shared/base \
    && ln -s /srv/bsc-shared/base /home/agent/.base-studio-code \
    && chown -h agent:bsc-agents /home/agent/.base-studio-code \
    && install -d -o agent -g bsc-agents -m 700 /home/agent/worktrees

# THE SEAL — baked into the image so the distro is locked down from its first boot (see ./wsl.conf):
#   automount.enabled=false  → no /mnt/c; the Windows drive is unreachable
#   interop.enabled=false    → no calling back out to Windows executables
#   user.default=agent       → never root by default
COPY wsl.conf /etc/wsl.conf

USER agent
WORKDIR /home/agent
