#!/usr/bin/env bash
# The whole isolation + store-surface system, in one view.
#
# Runs a real agent in a real namespace against the REAL stores and shows both halves: what it can
# do, and what it structurally cannot. Nothing here is simulated — every line is the output of an
# actual bwrap launch rendered by crates/bsc-sandbox.
#
#   bash tools/sandbox/demo.sh                       # stores under $HOME
#   bash tools/sandbox/demo.sh --home /mnt/c/Users/k # stores under a Windows profile
#   bash tools/sandbox/demo.sh --graph g.json --ui u.json   # pre-exported (older bsc on PATH)
#
# Plan: phase-2-kernel-isolation-replaces-the-hook-floor · phase-3-store-surfaces-are-filesystems
set -u

# The bsc stores resolve against a HOME. On a Windows host driving WSL that is the Windows
# profile, not /root — which is why an earlier version of this demo exported 0 graph nodes and
# 0 components and still printed a confident-looking summary.
BSC_HOME="${HOME}"
DB_OVERRIDE=""
GRAPH_JSON=""
UI_JSON=""
while [ $# -gt 0 ]; do
  case "$1" in
    --home)  BSC_HOME="$2"; shift 2 ;;
    --db)    DB_OVERRIDE="$2"; shift 2 ;;
    --graph) GRAPH_JSON="$2"; shift 2 ;;
    --ui)    UI_JSON="$2"; shift 2 ;;
    *)      shift ;;
  esac
done
DB="${DB_OVERRIDE:-$BSC_HOME/.base-studio-code/plans/core.db}"

ROOT="${HOME}/.cache/bsc-demo"
WT="$ROOT/worktree"; PROJ="$ROOT/projection"; OUT="$ROOT/outbox"; LOG="$ROOT/coord.log"
rm -rf "$ROOT"; mkdir -p "$WT" "$OUT"
echo "a source file the worker owns" > "$WT/mine.rs"

need() { command -v "$1" >/dev/null || { echo "MISSING DEPENDENCY: $1"; exit 2; }; }
need bwrap; need cargo; need systemd-run; need bsc; need node

hr() { printf '%s\n' "--------------------------------------------------------------------"; }
ok() { printf '  %-32s %s\n' "$1" "$2"; }
count_json() { node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)}catch(e){console.log(0)}' "$1" 2>/dev/null || echo 0; }

echo "EXPORTING THE REAL STORES"; hr
[ -f "$DB" ] || { echo "  no plan db at $DB - pass --home <dir> or --db <path>"; exit 2; }
BSC_PLAN_DB="$DB" bsc plan list --full --json > "$ROOT/plan.json" 2>/dev/null
ok "plan"  "$(count_json "$ROOT/plan.json") items"
# NOTE: `bsc` prints usage and exits 0 on an unknown subcommand, so an OLD binary yields an empty
# export with a SUCCESSFUL exit status. The count guard below is what catches that, not the rc.
# The /usr/bin/bsc in this distro predates `graph` entirely, hence --graph/--ui taking a
# pre-exported file from whichever bsc does know the verb.
if [ -n "$GRAPH_JSON" ]; then cp "$GRAPH_JSON" "$ROOT/graph.json"
else HOME="$BSC_HOME" bsc algorithms impl list > "$ROOT/graph.json" 2>/dev/null; fi
ok "graph" "$(count_json "$ROOT/graph.json") implementations"
if [ -n "$UI_JSON" ]; then cp "$UI_JSON" "$ROOT/ui.json"
else HOME="$BSC_HOME" bsc components list > "$ROOT/ui.json" 2>/dev/null; fi
ok "ui"    "$(count_json "$ROOT/ui.json") components"
cp "$BSC_HOME/.base-studio-code/coord.log" "$LOG" 2>/dev/null || : > "$LOG"
ok "coord" "$(wc -l < "$LOG") events"

# An empty export means a confident-looking demo over nothing. Refuse rather than proceed —
# the first run of this script did exactly that and looked fine.
for f in plan graph ui; do
  [ "$(count_json "$ROOT/$f.json")" -gt 0 ] || { echo; echo "  REFUSING: the $f export is empty - check --home"; exit 1; }
done
hr

STORE_ARGS=(--plan "$ROOT/plan.json" --graph "$ROOT/graph.json" --ui "$ROOT/ui.json" --coord "$LOG" --outbox "$OUT")

echo "PROJECTING + RENDERING THE NAMESPACE"; hr
cargo run -q -p bsc-storefs --example stores -- "$WT" "$PROJ" "${STORE_ARGS[@]}" -- true \
  > "$ROOT/argv.txt" 2> "$ROOT/render.log" || { sed 's/^/  /' "$ROOT/render.log"; exit 1; }
sed 's/^/  /' "$ROOT/render.log"
ok "argv arguments" "$(wc -l < "$ROOT/argv.txt")"
hr

# Re-rendered per command: the systemd scope name must be unique per launch or the second is
# refused with "Unit X.scope was already loaded".
run()   { cargo run -q -p bsc-storefs --example stores -- "$WT" "$PROJ" "${STORE_ARGS[@]}" -- "$@" > "$ROOT/a.txt" 2>/dev/null || return 1; mapfile -t A < "$ROOT/a.txt"; "${A[@]}" 2>&1; }
sh_in() { run /usr/bin/dash -c "$1"; }

echo "WHAT THE AGENT CAN DO"; hr
ok "read its plan"        "$(sh_in 'cat /plan/items/phase-0-linux-port-viability/status')"
ok "count open items"     "$(sh_in 'ls /plan/by-status/open | wc -l')"
ok "read the graph"       "$(sh_in 'ls /graph/impl | wc -l') implementations"
ok "read the ui index"    "$(sh_in 'ls /ui/components | wc -l') components"
ok "read coordination"    "$(sh_in 'wc -l < /coord/log') events"
ok "work in its worktree" "$(sh_in 'cat /repo/mine.rs')"
ok "learn how to emit"    "$(sh_in 'sed -n 3p /coord/schema')"
# Network is DERIVED from the role gate axes, not a blanket grant: a worker is git+github, so it
# has one. A designer is none/none/none and runs with the network unshared.
ok "reach the network"    "$(sh_in 'cat /proc/net/route >/dev/null 2>&1 && echo "shared - worker is git+github" || echo unshared')"
hr

echo "WHAT THE AGENT STRUCTURALLY CANNOT DO"; hr
ok "reach bsc"           "$(sh_in 'command -v bsc >/dev/null && echo REACHABLE || echo absent')"
ok "reach sudo/curl/dd"  "$(sh_in 'command -v sudo curl dd >/dev/null && echo REACHABLE || echo absent')"
# Precise on purpose: a bare count reads as "the agent reached 3 databases". The only .db files
# it can see are incidental /usr data (firmware regulatory.db, avahi service-types.db, an xtrans
# doc) — no app store is reachable at all.
ok "reach an APP store db" "$(sh_in 'find / -name "*.db" -not -path "/proc/*" -not -path "/usr/*" 2>/dev/null | wc -l') (plus $(sh_in 'find /usr -name "*.db" 2>/dev/null | wc -l') incidental /usr files)"
ok "see other processes" "$(sh_in 'ls /proc | grep -c "^[0-9]"') (host has $(ls /proc | grep -c '^[0-9]'))"
ok "see other agents"    "$(sh_in 'ls /home 2>/dev/null | wc -l') entries"
ok "write to /plan"      "$(sh_in 'echo x > /plan/README 2>&1 | head -1 | sed "s|.*: ||" | cut -c1-34')"
hr

echo "THE COORDINATION LOOP"; hr
sh_in 'echo "the demo ran end to end" > /coord/out/landed' >/dev/null
sh_in 'echo oops > /coord/out/nonsense' >/dev/null
ok "agent emitted"         "$(ls "$OUT" | tr '\n' ' ')"
BEFORE=$(wc -l < "$LOG")
cargo run -q -p bsc-storefs --example coord-drain -- "$OUT" "$LOG" "demo:worker" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" worker | sed 's/^/  drain: /'
ok "log lines"             "$BEFORE -> $(wc -l < "$LOG")"
ok "appended"              "$(tail -1 "$LOG" | cut -f3,4 | tr '\t' ' ')"
ok "refusal names the fix" "$(sh_in 'sed -n 3p /coord/out/nonsense.rejected')"
hr

echo "Four stores read and one event emitted with no CLI, no database, and no binary the agent"
echo "was not explicitly granted. Its writable blast radius is /repo and /coord/out."
rm -rf "$ROOT"
