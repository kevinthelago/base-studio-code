#!/usr/bin/env bash
# End-to-end proof that the gates FIRE INSIDE a namespace.
#
# Everything below executes; nothing is asserted about strings. The binary is built for Linux,
# bound into a real bwrap namespace exactly as the spec renders it, and driven with the tool JSON
# Claude Code actually sends.
set -u

SRC=/mnt/c/Users/Kevin/Projects/rust/base-studio-code/wt-floor
W=$HOME/hooke2e
rm -rf "$W"; mkdir -p "$W/src"

# Build bsc-hook natively. Copy the two crates out of /mnt/c first — building on a 9p mount is
# glacial and the point here is the behaviour, not the build.
mkdir -p "$W/build/crates"
cp -r "$SRC/crates/bsc-hook" "$W/build/crates/" 2>/dev/null
cp -r "$SRC/crates/bsc-util" "$W/build/crates/" 2>/dev/null
cat > "$W/build/Cargo.toml" <<'TOML'
[workspace]
members = ["crates/bsc-hook", "crates/bsc-util"]
resolver = "2"
TOML
( cd "$W/build" && cargo build --release -p bsc-hook 2>&1 | tail -3 )
HOOK="$W/build/target/release/bsc-hook"
[ -x "$HOOK" ] || { echo "BUILD FAILED"; exit 1; }
echo "built: $(du -h "$HOOK" | cut -f1)  $(file -b "$HOOK" | cut -c1-60)"

# A worktree with two files: one inside the write scope, one outside it.
mkdir -p "$W/repo/src/features" "$W/repo/src/store"
echo "in scope"  > "$W/repo/src/features/ok.rs"
echo "out"       > "$W/repo/src/store/nope.rs"

run_gate() { # <gate> <json>  -> prints rc
  bwrap --unshare-all --die-with-parent --clearenv \
    --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin \
    --proc /proc --dev /dev --tmpfs /tmp \
    --ro-bind "$HOOK" /bsc-hook \
    --bind "$W/repo" /repo --chdir /repo \
    --setenv HOME /repo \
    --setenv BSC_REPO_ROOT /repo \
    --setenv BSC_SCOPE_GLOBS 'src/features/**' \
    --setenv BSC_DENY_BASH 'vi' \
    -- /bsc-hook "$1" <<<"$2" >/dev/null 2>&1
  echo $?
}

pass=0; fail=0
check() { # <label> <want_rc> <got_rc>
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok    $1 (rc=$3)"
  else fail=$((fail+1)); echo "  FAIL  $1 — wanted rc=$2 got rc=$3"; fi
}

echo
echo "== write-scope: the check a mount namespace CANNOT express =="
check "write inside scope is allowed" 0 \
  "$(run_gate scope '{"tool_input":{"file_path":"/repo/src/features/ok.rs"}}')"
check "write OUTSIDE scope is blocked" 2 \
  "$(run_gate scope '{"tool_input":{"file_path":"/repo/src/store/nope.rs"}}')"
check "star crosses a slash, so a deep path is in scope" 0 \
  "$(run_gate scope '{"tool_input":{"file_path":"/repo/src/features/a/b/c.rs"}}')"

echo
echo "== dangerous-command floor: compiled in, needs no config =="
check "rm -rf / is blocked" 2 \
  "$(run_gate bash-deny '{"tool_input":{"command":"rm -rf /"}}')"
check "an ordinary build command is allowed" 0 \
  "$(run_gate bash-deny '{"tool_input":{"command":"cargo build"}}')"
check "a session deny pattern blocks its program" 2 \
  "$(run_gate bash-deny '{"tool_input":{"command":"vi notes.txt"}}')"
check "the same pattern does NOT match inside a path" 0 \
  "$(run_gate bash-deny '{"tool_input":{"command":"ls /home/Kevin/src"}}')"

echo
echo "== the gate must not have brought bsc or a store in with it =="
# NOTE: this block uses the CURATED /usr the real spec renders — individual --ro-bind-try per
# binary — not the whole-/usr shape the blocks above use for brevity. Binding /usr wholesale would
# drag `bsc` in and the check would be meaningless.
curated=()
for b in bash cat ls dash grep sed; do   # NOT sh — the spec creates it as a symlink to dash
  curated+=(--ro-bind-try "/usr/bin/$b" "/usr/bin/$b")
done
inside=$(bwrap --unshare-all --die-with-parent --clearenv   --ro-bind /usr/lib /usr/lib --ro-bind-try /usr/lib64 /usr/lib64   "${curated[@]}" --symlink dash /usr/bin/sh   --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin   --proc /proc --dev /dev --tmpfs /tmp   --ro-bind "$HOOK" /bsc-hook   --bind "$W/repo" /repo --chdir /repo --setenv HOME /repo   -- /usr/bin/sh -c 'command -v bsc || echo NO_BSC' 2>&1)
check "bsc is unreachable under the curated /usr the spec renders" "NO_BSC" "$inside"

gate_still_works=$(bwrap --unshare-all --die-with-parent --clearenv   --ro-bind /usr/lib /usr/lib --ro-bind-try /usr/lib64 /usr/lib64   "${curated[@]}" --symlink dash /usr/bin/sh   --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin   --proc /proc --dev /dev --tmpfs /tmp   --ro-bind "$HOOK" /bsc-hook   --bind "$W/repo" /repo --chdir /repo --setenv HOME /repo   --setenv BSC_REPO_ROOT /repo --setenv BSC_SCOPE_GLOBS 'src/features/**'   -- /bsc-hook scope <<<'{"tool_input":{"file_path":"/repo/src/store/nope.rs"}}' >/dev/null 2>&1; echo $?)
check "and the gate still fires there (curated /usr, not just Usr::All)" 2 "$gate_still_works"

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" = 0 ] || exit 1
