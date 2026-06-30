# The sealed, model-agnostic WSL2 agent sandbox rootfs (#1988 / #1982 / #1916).
#
# A purpose-built Linux root filesystem that becomes a WSL2 distro (`bsc-agent-sandbox`). Whatever
# agent runtime runs *inside* it — Claude Code, or `bsc-agent` driving any LLM — is confined by the
# distro itself: the seal is baked into /etc/wsl.conf (no Windows mount, no interop), so the cage does
# not depend on the agent runtime cooperating. This is the model-agnostic answer to Claude Code's own
# (Claude-only) Bash sandbox.
#
# Build → tarball with ./build-rootfs.sh, then `wsl --import bsc-agent-sandbox <dir> agent-sandbox.tar`.
FROM debian:stable-slim

# The minimal toolchain a session needs: git for the worktrees, certs for HTTPS (git/gh/LLM APIs),
# ssh-client for git-over-ssh remotes. Everything else an agent needs it brings or asks for.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates git openssh-client procps \
    && rm -rf /var/lib/apt/lists/*

# Our slim Linux sidecars. The unified `bsc` is built WITHOUT the `data` feature (DuckDB is
# `optional = true`), so it carries `bsc plan` / `bsc skill` / `bsc logs` — everything a session
# needs — without the heavy C++ dep. Produced by CI / tooling (see README); dropped into ./bin first.
COPY bin/bsc /usr/local/bin/bsc
COPY bin/bsc-agent /usr/local/bin/bsc-agent
RUN chmod +x /usr/local/bin/bsc /usr/local/bin/bsc-agent

# A non-root user the sessions run as.
RUN useradd --create-home --shell /bin/bash agent

# THE SEAL — baked into the image so the distro is locked down from its first boot (see ./wsl.conf):
#   automount.enabled=false  → no /mnt/c; the Windows drive is unreachable
#   interop.enabled=false    → no calling back out to Windows executables
#   user.default=agent       → never root by default
COPY wsl.conf /etc/wsl.conf

# OPTIONAL — only if Claude Code should run *inside* the sandbox (bsc-agent on other models needs none
# of this). Uncomment to bake Node + the CLI in:
# RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
#     && npm install -g @anthropic-ai/claude-code && rm -rf /var/lib/apt/lists/*

USER agent
WORKDIR /home/agent
