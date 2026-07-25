// The design-loop status pill + the REACHABLE kill switch (#3292) and the overnight TRIGGER (#3304, epic
// #3260). For a `--until false` (infinite) loop the human is the only brake, so the stop must not be buried
// behind a CLI: this pill appears whenever a `driver ↔ designer` loop is open, shows the running
// change-count + cost (so an overnight run is observable, not a black box), and its Stop button closes the
// loop out-of-band — the halt the participants themselves can't reach. Polls the loop store directly, so it
// stays truthful even if the pump is between ticks.
//
// When NO loop is open it collapses to a single opt-in "Auto-improve" control — the #3304 trigger. That
// control is the ONLY way an overnight run starts: nothing auto-starts it, and because the run state is not
// persisted, a restart always lands back here with the loop off.
import { useState } from "react";
import { usePoll } from "@/shared/hooks/usePoll";
import { useAppStore } from "@/store";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { bscJson, bscRun } from "@/shared/lib/core/bsc";
import { pickDesignerLoop, DESIGNER, type LoopRow, type LoopTurn } from "./lib/designerLoopDrive";
import "./designerLoopBanner.css";

interface ActiveLoop {
  id: number;
  changes: number; // the designer's recorded turns (each = one shot-paired change)
  cost: number;
}

export function DesignerLoopBanner() {
  const [active, setActive] = useState<ActiveLoop | null>(null);
  const [starting, setStarting] = useState(false);
  const overnight = useAppStore((s) => s.designerOvernight);
  const startOvernight = useAppStore((s) => s.startDesignerOvernight);
  const stopOvernight = useAppStore((s) => s.stopDesignerOvernight);

  usePoll(
    async (isCancelled) => {
      const loops = await bscJson<LoopRow[]>(null, ["loop", "list", "--open", "--json"], []);
      if (isCancelled()) return;
      const loop = pickDesignerLoop(loops);
      if (!loop) {
        setActive(null);
        return;
      }
      const show = await bscJson<{ turns: LoopTurn[]; total_cost: number } | null>(
        null,
        ["loop", "show", String(loop.id), "--json"],
        null,
      );
      if (isCancelled() || !show) return;
      const changes = (show.turns ?? []).filter((t) => t.participant === DESIGNER).length;
      setActive({ id: loop.id, changes, cost: show.total_cost ?? 0 });
    },
    3000,
    [],
  );

  const start = async () => {
    setStarting(true);
    try {
      await startOvernight();
    } finally {
      setStarting(false);
    }
  };

  // Idle — offer the opt-in trigger. Deliberately a plain, unpulsing pill: nothing is running.
  if (!active) {
    return (
      <Box className="designer-loop-banner dlb-idle">
        {/* eslint-disable-next-line no-restricted-syntax -- a self-contained pill button; the shared Button carries layout this overlay doesn't want */}
        <button
          type="button"
          className="dlb-start"
          onClick={() => void start()}
          disabled={starting}
          title="Start an autonomous, budget-bounded design run (bsc loop, overnight mode)"
        >
          {starting ? "Starting…" : "Auto-improve"}
        </button>
      </Box>
    );
  }

  // Stop covers BOTH shapes: an overnight run halts through the store action (which flags `stopping` so the
  // pump stops dispatching immediately and keeps retrying the halt), a plain interactive loop through the
  // direct out-of-band stop. The optimistic hide is skipped while stopping an overnight run, so the user
  // keeps seeing the run until it is really gone rather than being told it stopped before it has.
  const stop = () => {
    if (overnight) {
      void stopOvernight();
      return;
    }
    void bscRun(null, ["loop", "stop", String(active.id)]);
    setActive(null); // optimistic — the next poll confirms it's gone
  };

  const stopping = overnight?.stopping ?? false;

  return (
    <Box className="designer-loop-banner" role="status" aria-label="design loop running">
      <Box as="span" className="dlb-dot" aria-hidden />
      <Text as="span" className="dlb-label mono">
        design loop #{active.id}
      </Text>
      <Text as="span" className="dlb-meta mono">
        {active.changes} change{active.changes === 1 ? "" : "s"} · ${active.cost.toFixed(2)}
        {overnight ? ` · auto ${overnight.cursor}/${overnight.maxTurns}` : ""}
      </Text>
      {/* eslint-disable-next-line no-restricted-syntax -- a self-contained pill button; the shared Button carries layout this overlay doesn't want */}
      <button
        type="button"
        className="dlb-stop"
        onClick={stop}
        disabled={stopping}
        title="Halt the loop (bsc loop stop)"
      >
        {stopping ? "Stopping…" : "Stop"}
      </button>
    </Box>
  );
}
