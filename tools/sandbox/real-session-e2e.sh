#!/usr/bin/env bash
# THE WORKING VERSION: a real Claude Code session running inside a mount namespace.
#
# Everything below executes. This is the acceptance criterion that has been open since the harness
# item was filed -- "a real agent session starts INSIDE a namespace and reaches the model,
# demonstrated by running one rather than asserted".
set -u

W=$HOME/realsession
rm -rf "$W"; mkdir -p "$W/mine" "$W/theirs"
echo "fn main() { println!(\"hello\"); }" > "$W/mine/main.rs"
echo "ANOTHER AGENT'S SECRET" > "$W/theirs/secret.txt"

CRED=/mnt/c/Users/Kevin/.claude/.credentials.json
HOOK=$W/../hooke2e/build/target/x86_64-unknown-linux-musl/release/bsc-hook

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok    $1"
          else fail=$((fail+1)); echo "  FAIL  $1 — wanted [$2] got [$3]"; fi; }

# The namespace the shipped spec renders, with the harness's runtime added via extra_bins.
run() {
  local net="$1"; shift
  local args=(--unshare-all $net --die-with-parent --clearenv
    --ro-bind /usr/lib /usr/lib --ro-bind-try /usr/lib64 /usr/lib64 --ro-bind-try /usr/share /usr/share
    --ro-bind-try /etc/ssl /etc/ssl --ro-bind-try /etc/resolv.conf /etc/resolv.conf)
  for b in bash cat ls dash node claude env grep sed; do
    args+=(--ro-bind-try "/usr/bin/$b" "/usr/bin/$b")
  done
  args+=(--symlink dash /usr/bin/sh --symlink usr/bin /sbin
    --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin
    --proc /proc --dev /dev --tmpfs /tmp
    --ro-bind "$HOOK" /bsc-hook
    --tmpfs /home/agent --ro-bind "$CRED" /home/agent/.claude/.credentials.json
    --bind "$W/mine" /repo --chdir /repo
    --setenv HOME /home/agent --setenv TERM xterm
    --setenv BSC_REPO_ROOT /repo --setenv BSC_SCOPE_GLOBS '*.rs')
  bwrap "${args[@]}" -- "$@" 2>&1
}

echo "== 1. the harness runs INSIDE the namespace =="
check "claude --version" "0" "$(run --share-net /usr/bin/claude --version >/dev/null 2>&1; echo $?)"
echo "     $(run --share-net /usr/bin/claude --version 2>&1 | tail -1)"

echo
echo "== 2. it can read its credential, and cannot alter it =="
check "credential readable" "ok" \
  "$(run --share-net /usr/bin/sh -c '[ -s $HOME/.claude/.credentials.json ] && echo ok || echo missing' | tail -1)"
check "credential read-only" "readonly" \
  "$(run --share-net /usr/bin/sh -c '(echo x > $HOME/.claude/.credentials.json) 2>/dev/null && echo WRITABLE || echo readonly' | tail -1)"
check "no other project state crossed" "1" \
  "$(run --share-net /usr/bin/ls -A /home/agent/.claude | wc -l | tail -1)"

echo
echo "== 3. the isolation holds while the harness is present =="
check "a sibling worktree is UNREACHABLE" "gone" \
  "$(run --share-net /usr/bin/sh -c "cat $W/theirs/secret.txt >/dev/null 2>&1 && echo LEAKED || echo gone" | tail -1)"
check "its own worktree IS reachable" "hello" \
  "$(run --share-net /usr/bin/sh -c 'grep -o hello /repo/main.rs' | tail -1)"

echo
echo "== 4. the gates are reachable and fire =="
check "write outside scope blocked" "2" \
  "$(run --share-net /usr/bin/sh -c 'echo "{\"tool_input\":{\"file_path\":\"/repo/notes.md\"}}" | /bsc-hook scope >/dev/null 2>&1; echo $?' | tail -1)"
check "write inside scope allowed" "0" \
  "$(run --share-net /usr/bin/sh -c 'echo "{\"tool_input\":{\"file_path\":\"/repo/main.rs\"}}" | /bsc-hook scope >/dev/null 2>&1; echo $?' | tail -1)"

echo
echo "== 5. IT REACHES THE MODEL =="
out=$(run --share-net /usr/bin/claude -p 'Reply with exactly: SANDBOXED' </dev/null 2>&1 | tail -3)
case "$out" in
  *SANDBOXED*) pass=$((pass+1)); echo "  ok    a real turn completed from inside the namespace";;
  *)           fail=$((fail+1)); echo "  FAIL  no model response. got: ${out:0:300}";;
esac

echo
echo "== 6. and with the network unshared, it cannot =="
noNet=$(run --unshare-net /usr/bin/claude -p 'hi' </dev/null 2>&1 | tail -2)
case "$noNet" in
  *SANDBOXED*|*Hello*|*hi*) fail=$((fail+1)); echo "  FAIL  reached the model with no network";;
  *) pass=$((pass+1)); echo "  ok    no network ⇒ no model (${noNet:0:60}...)";;
esac

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" = 0 ] || exit 1
