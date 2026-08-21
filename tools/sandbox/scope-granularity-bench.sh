#!/usr/bin/env bash
# What does namespace granularity actually COST?
#
# The question: sandbox per PROJECT (one namespace, every agent inside) or per NODE (one namespace
# per agent, which is what ships today). Per-node is what the phase-0 escape test proves; per-project
# gives that up. So the only thing worth measuring is what per-node COSTS, because if it is cheap the
# trade is not a trade.
set -u

N=${1:-8}   # agents in the fleet
W=$HOME/scopebench
rm -rf "$W"; mkdir -p "$W"
for i in $(seq "$N"); do mkdir -p "$W/wt$i"; echo "agent $i" > "$W/wt$i/file.txt"; done

echo "machine: $(nproc) cpus, load $(cut -d' ' -f1-3 /proc/loadavg)"
echo "fleet size: $N"
echo

BASE=(--die-with-parent --clearenv
  --ro-bind /usr/lib /usr/lib --ro-bind-try /usr/lib64 /usr/lib64
  --ro-bind-try /usr/bin/dash /usr/bin/dash --ro-bind-try /usr/bin/cat /usr/bin/cat
  --ro-bind-try /usr/bin/ls /usr/bin/ls
  --symlink dash /usr/bin/sh --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin
  --proc /proc --dev /dev --tmpfs /tmp)

# ── PER-NODE: one namespace per agent, each seeing ONLY its own worktree ───────────────────────
t0=$(date +%s%N)
for i in $(seq "$N"); do
  bwrap --unshare-all "${BASE[@]}" --bind "$W/wt$i" /repo --chdir /repo \
    -- /usr/bin/sh -c 'cat /repo/file.txt' >/dev/null 2>&1
done
t1=$(date +%s%N)
per_node_ms=$(( (t1 - t0) / 1000000 ))

# ── PER-PROJECT: ONE namespace holding every worktree; agents run inside it ────────────────────
t0=$(date +%s%N)
bwrap --unshare-all "${BASE[@]}" --bind "$W" /project --chdir /project \
  -- /usr/bin/sh -c 'for i in $(seq '"$N"'); do cat /project/wt$i/file.txt; done' >/dev/null 2>&1
t1=$(date +%s%N)
per_project_ms=$(( (t1 - t0) / 1000000 ))

echo "SETUP COST"
echo "  per-node    ($N namespaces): ${per_node_ms} ms   ($(( per_node_ms / N )) ms per agent)"
echo "  per-project (1 namespace)  : ${per_project_ms} ms"
echo "  difference                 : $(( per_node_ms - per_project_ms )) ms across the whole fleet"
echo

# ── THE PROPERTY THAT IS ACTUALLY BEING TRADED ────────────────────────────────────────────────
echo "CROSS-AGENT ISOLATION (agent 1 reading agent 2's worktree)"
node_leak=$(bwrap --unshare-all "${BASE[@]}" --bind "$W/wt1" /repo --chdir /repo \
  -- /usr/bin/sh -c "cat $W/wt2/file.txt" 2>&1 | head -1)
case "$node_leak" in
  *"agent 2"*) echo "  per-node   : LEAKED — $node_leak" ;;
  *)           echo "  per-node   : blocked (${node_leak:0:48}...)" ;;
esac
proj_leak=$(bwrap --unshare-all "${BASE[@]}" --bind "$W" /project --chdir /project \
  -- /usr/bin/sh -c 'cat /project/wt2/file.txt' 2>&1 | head -1)
case "$proj_leak" in
  *"agent 2"*) echo "  per-project: LEAKED — agent 1 read agent 2's worktree" ;;
  *)           echo "  per-project: blocked (${proj_leak:0:48}...)" ;;
esac

echo
echo "PER-NAMESPACE MEMORY (a namespace is bind mounts + a pid/net ns, not a copy)"
before=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
pids=()
for i in $(seq "$N"); do
  bwrap --unshare-all "${BASE[@]}" --bind "$W/wt$i" /repo --chdir /repo \
    -- /usr/bin/sh -c 'read x' >/dev/null 2>&1 &
  pids+=($!)
done
sleep 2
during=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
wait 2>/dev/null
echo "  $N live namespaces cost $(( (before - during) )) kB total, $(( (before - during) / N )) kB each"
rm -rf "$W"
