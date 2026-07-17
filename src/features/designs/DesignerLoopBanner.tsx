// The design-loop status pill + the REACHABLE kill switch (#3292, epic #3260). For a `--until false`
// (infinite) loop the human is the only brake, so the stop must not be buried behind a CLI: this pill
// appears whenever a `driver ↔ designer` loop is open, shows the running change-count + cost (so an
// overnight run is observable, not a black box), and its Stop button closes the loop out-of-band via
// `bsc loop stop` — the halt the participants themselves can't reach. Polls the loop store directly, so it
// stays truthful even if the pump is between ticks.
import { useState } from "react";
import { usePoll } from "@/shared/hooks/usePoll";
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

  if (!active) return null;

  const stop = () => {
    void bscRun(null, ["loop", "stop", String(active.id)]);
    setActive(null); // optimistic — the next poll confirms it's gone
  };

  return (
    <Box className="designer-loop-banner" role="status" aria-label="design loop running">
      <Box as="span" className="dlb-dot" aria-hidden />
      <Text as="span" className="dlb-label mono">
        design loop #{active.id}
      </Text>
      <Text as="span" className="dlb-meta mono">
        {active.changes} change{active.changes === 1 ? "" : "s"} · ${active.cost.toFixed(2)}
      </Text>
      {/* eslint-disable-next-line no-restricted-syntax -- a self-contained pill button; the shared Button carries layout this overlay doesn't want */}
      <button type="button" className="dlb-stop" onClick={stop} title="Halt the loop (bsc loop stop)">
        Stop
      </button>
    </Box>
  );
}
