#!/usr/bin/env bash
# Proves the HARNESS ENVIRONMENT a sandboxed session gets: node reachable, a private tmpfs HOME,
# exactly one credential readable, nothing else from the host home, and no network for a role that
# should not have one.
#
# Everything executes. The one thing NOT proven here is Claude Code itself starting: it is not
# installed in this WSL, and installing a harness into a stopgap environment to test a stopgap is
# not worth it. That check belongs on the phase-1 Linux host.
set -u

W=$HOME/harnesse2e
rm -rf "$W"; mkdir -p "$W/repo" "$W/hosthome/.claude"

# A host ~/.claude shaped like the real one: the credential PLUS things that must NOT cross.
echo '{"token":"SECRET-TOKEN-XYZ"}'      > "$W/hosthome/.claude/.credentials.json"
echo 'every project transcript'          > "$W/hosthome/.claude/history.jsonl"
mkdir -p "$W/hosthome/.claude/projects/someone-elses"
echo 'another projects notes'            > "$W/hosthome/.claude/projects/someone-elses/notes.md"
echo '{"globalSettings":true}'           > "$W/hosthome/.claude/settings.json"

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok    $1"
          else fail=$((fail+1)); echo "  FAIL  $1 — wanted [$2] got [$3]"; fi; }

# The spec's shape: curated /usr WITH node, private tmpfs HOME, one credential bound read-only.
run() { # <extra bwrap args...> -- <cmd...>
  local netarg="$1"; shift
  local bins=(bash cat ls dash node)
  local args=(--unshare-all $netarg --die-with-parent --clearenv
    --ro-bind /usr/lib /usr/lib --ro-bind-try /usr/lib64 /usr/lib64 --ro-bind-try /usr/share /usr/share)
  for b in "${bins[@]}"; do args+=(--ro-bind-try "/usr/bin/$b" "/usr/bin/$b"); done
  args+=(--symlink dash /usr/bin/sh --symlink usr/bin /sbin
    --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin
    --proc /proc --dev /dev --tmpfs /tmp
    --tmpfs /home/agent
    --ro-bind "$W/hosthome/.claude/.credentials.json" /home/agent/.claude/.credentials.json
    --bind "$W/repo" /repo --chdir /repo
    --setenv HOME /home/agent --setenv TERM xterm)
  bwrap "${args[@]}" -- "$@" 2>&1
}

echo "== the harness runtime is reachable =="
check "node runs inside the namespace" "OK" \
  "$(run --unshare-net /usr/bin/node -e 'console.log("OK")' | tail -1)"

echo
echo "== HOME is private, writable, and NOT the worktree =="
check "HOME is the tmpfs, not /repo" "/home/agent" \
  "$(run --unshare-net /usr/bin/sh -c 'echo $HOME' | tail -1)"
check "harness state can be written there" "written" \
  "$(run --unshare-net /usr/bin/sh -c 'echo written > $HOME/state.json && cat $HOME/state.json' | tail -1)"
check "and it does NOT land in the worktree" "clean" \
  "$(run --unshare-net /usr/bin/sh -c 'echo x > $HOME/state.json; ls /repo | grep -q . && echo dirty || echo clean' | tail -1)"

echo
echo "== exactly one secret crosses =="
check "the credential is readable by the harness" '{"token":"SECRET-TOKEN-XYZ"}' \
  "$(run --unshare-net /usr/bin/cat /home/agent/.claude/.credentials.json | tail -1)"
check "the credential cannot be modified" "readonly" \
  "$(run --unshare-net /usr/bin/sh -c '(echo tampered > $HOME/.claude/.credentials.json) 2>/dev/null && echo WRITABLE || echo readonly' | tail -1)"
check "another project's transcripts are ABSENT" "absent" \
  "$(run --unshare-net /usr/bin/sh -c '[ -e $HOME/.claude/history.jsonl ] && echo LEAKED || echo absent' | tail -1)"
check "another project's notes are ABSENT" "absent" \
  "$(run --unshare-net /usr/bin/sh -c '[ -e $HOME/.claude/projects ] && echo LEAKED || echo absent' | tail -1)"
check "the host's global settings are ABSENT" "absent" \
  "$(run --unshare-net /usr/bin/sh -c '[ -e $HOME/.claude/settings.json ] && echo LEAKED || echo absent' | tail -1)"
check "the guest .claude holds ONLY the credential" ".credentials.json" \
  "$(run --unshare-net /usr/bin/ls -A /home/agent/.claude | tail -1)"

echo
echo "== holding a token is not the same as being able to send it =="
check "a no-network role cannot reach out, credential in hand" "unreachable" \
  "$(run --unshare-net /usr/bin/node -e 'require("dns").lookup("api.anthropic.com",e=>console.log(e?"unreachable":"REACHED"))' | tail -1)"

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" = 0 ] || exit 1
