// GlanceTerminalGrid (#3361) — the docked grid of OPEN agent sessions. Sits in `GraphCanvas`'s `dock`
// slot (#2755, below the canvas), so the graph keeps the remaining height and the terminals keep a
// constant, zoom-independent size.
//
// REPLACES the single in-graph morph (`GlanceStreamMorph`, #2534/#2662/#2671): only one node could be
// open, and its world-layer card scaled with the graph, so it had to force `zoomTo(1)` on open to stay
// legible. That trade works for one panel and fails for a grid, whose whole premise is reading several
// sessions at once. Moving terminals out of the world layer also retires the parting machinery
// (`partAroundPanel` / `morphRect` / the edge re-route) — with nothing overlapping the graph, there is
// nothing to part around.
//
// Each cell is a plain `GlanceChatDock`, unchanged: it already renders its own header (name · role ·
// live · Stream/Logs · End session · ✕) and fills its container, which is exactly a grid cell. The
// terminal inside is a `<TerminalSlot>`, so the app-level TerminalHost RE-PARENTS each agent's single
// existing terminal into its cell — N open cells = N independent paneIds, which the host already
// supports (its claim registry is keyed by paneId, one portal + container each). No second xterm, no
// PTY respawn, no cross-cell contention.
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { useDragResize } from "@/shared/hooks/useDragResize";
import { GlanceChatDock } from "./GlanceChatDock";
import { gridShape, MIN_CELL_H } from "./lib/terminalGrid";

/** One open session — resolved by the workspace from its node + live pane id. */
export interface GlanceOpenSession {
  nodeId: string;
  paneId: string;
  name: string;
  role?: string;
}

/** Dock sizing. `DEFAULT_H` is a touch under half the page so the graph stays the larger surface. */
const DEFAULT_H = 380;
const MIN_H = 180;
const MAX_H = 1200;

export function GlanceTerminalGrid({
  sessions, onClose, onEnd,
}: {
  /** Open sessions, already ordered by graph position (`orderByPosition`). Empty ⇒ renders nothing. */
  sessions: GlanceOpenSession[];
  /** Collapse ONE cell — its PTY stays alive (the agent is untouched). */
  onClose: (nodeId: string) => void;
  /** END one cell's session — kill its PTY (#3049). */
  onEnd: (nodeId: string) => void;
}) {
  // The handle sits on the dock's TOP edge, so dragging UP must GROW it — `invert`, exactly like
  // GraphCanvas's right-hand inspector splitter.
  const drag = useDragResize({ initial: DEFAULT_H, min: MIN_H, max: MAX_H, axis: "y", invert: true });

  // Hooks must run unconditionally, so bail AFTER useDragResize.
  if (sessions.length === 0) return null;

  const { cols, rows } = gridShape(sessions.length);

  return (
    <Box style={{ flex: "none", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* Splitter — the dock's top edge. `.resize-y` is the shared horizontal-splitter affordance. */}
      <Box className="resize-y" {...drag.handleProps} title="Drag to resize the session dock" />
      <Box
        data-testid="glance-terminal-grid"
        style={{
          height: drag.size, flex: "none",
          borderTop: "1px solid var(--border)", background: "var(--bg)",
          display: "flex", flexDirection: "column", minHeight: 0,
        }}
      >
        <Row justify="between" align="center" style={{ padding: "5px 12px", flex: "none", borderBottom: "1px solid var(--border-soft)" }}>
          <Text mono size="xs" tone="dim">
            {sessions.length} open session{sessions.length === 1 ? "" : "s"}
          </Text>
        </Row>
        {/* The grid. `minmax(0, 1fr)` on both axes is load-bearing — a bare `1fr` floors at the
            content's min-content size, which a terminal ignores, and the cells would overflow the dock
            instead of sharing it. Rows floor at MIN_CELL_H and the dock scrolls past that, so a 7th
            session shrinks nothing into uselessness. */}
        <Box
          style={{
            flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden",
            display: "grid", gap: 8, padding: 8,
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(${MIN_CELL_H}px, 1fr))`,
          }}
        >
          {sessions.map((s) => (
            // Keyed by paneId (its stable session identity), NOT array index: a cell's identity must
            // survive re-ordering when a sibling opens/closes, or React would reuse the wrong cell and
            // the TerminalSlot inside would re-register against a different pane.
            <Box
              key={s.paneId}
              data-testid={`glance-terminal-cell-${s.nodeId}`}
              style={{
                minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column",
                border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden",
              }}
            >
              <GlanceChatDock
                paneId={s.paneId}
                name={s.name}
                role={s.role}
                onClose={() => onClose(s.nodeId)}
                onEnd={() => onEnd(s.nodeId)}
              />
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
