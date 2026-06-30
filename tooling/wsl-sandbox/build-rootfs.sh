#!/usr/bin/env bash
# Build the sealed agent-sandbox rootfs tarball (#1988).
#
#   ./build-rootfs.sh [output.tar]
#
# Produces a WSL2-importable root filesystem from ./Dockerfile. Requires Docker (docker-desktop is
# fine). The slim Linux `bsc` + `bsc-agent` binaries must be present in ./bin first (see README).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/agent-sandbox.tar}"
image="bsc-agent-sandbox:build"

# The image needs the Linux sidecars baked in. Fail early + loud if they're missing, rather than
# letting `docker build` emit an opaque COPY error.
for bin in bsc bsc-agent; do
  if [ ! -f "$here/bin/$bin" ]; then
    echo "error: $here/bin/$bin is missing." >&2
    echo "  Build the slim Linux sidecars and drop them in ./bin first, e.g.:" >&2
    echo "    cargo build --release -p bsc --no-default-features --target x86_64-unknown-linux-gnu" >&2
    echo "    cargo build --release -p bsc-agent          --target x86_64-unknown-linux-gnu" >&2
    echo "  (or pull them from the CI Linux artifact). Then copy them to ./bin/." >&2
    exit 1
  fi
done

echo "building image from $here/Dockerfile ..."
docker build -t "$image" "$here"

echo "exporting rootfs → $out ..."
cid="$(docker create "$image")"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
docker export "$cid" -o "$out"

echo
echo "done: $out"
echo "import it as a WSL2 distro with:"
echo "  wsl --import bsc-agent-sandbox \"\$HOME/.base-studio-code/wsl/bsc-agent-sandbox\" \"$out\" --version 2"
echo "then verify the seal (all should FAIL / be empty):"
echo "  wsl -d bsc-agent-sandbox -- ls /mnt/c            # no such directory"
echo "  wsl -d bsc-agent-sandbox -- powershell.exe       # command not found (interop off)"
