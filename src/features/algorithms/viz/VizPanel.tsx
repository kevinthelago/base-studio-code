// The Algorithms visualization surface (#3199/#3205). The animation is ALWAYS rendered inline in the
// inspector as a compact, auto-playing, looping preview (like a component thumbnail on the Components
// page). Clicking it does NOT open a modal — mirroring the Components page's theme try-on (#2834), it
// TAKES OVER THE GRAPH CANVAS: the workbench renders `VizStage` in GraphCanvas's `overlays` slot (rail +
// inspector stay), with a "← Back to graph" bar. So this file exports two pieces:
//   • VizPreview — the inline inspector thumbnail (lifts its expand to the workbench).
//   • VizStage   — the full in-canvas animation + editable "your input" field (rendered in overlays).
import { useCallback, useState } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { Button } from "@/shared/ui/controls/Button";
import { TextField } from "@/shared/ui/controls/Field";
import { InlineError } from "@/shared/ui/feedback/InlineError";
import type { Frame } from "../lib/trace";
import { TracePlayer } from "./TracePlayer";
import type { VizExample } from "./examples/registry";
import "./vizPanel.css";

/** The compact inline preview — a controls-less, auto-playing, looping player wrapped in a clickable
 *  affordance (hover/focus surfaces an expand cue). Activating it lifts to the workbench, which promotes
 *  the animation to the full graph canvas (#3205). */
export function VizPreview({ viz, onExpand }: { viz: VizExample; onExpand: () => void }) {
  return (
    <Box
      className="algo-viz-preview"
      role="button"
      tabIndex={0}
      aria-label="Expand visualization — take a closer look and try your own input"
      title="Expand — take a closer look and try your own input"
      onClick={onExpand}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onExpand();
        }
      }}
    >
      <TracePlayer factory={viz.factory} renderers={viz.renderers} fps={3} autoPlay loop controls={false} />
      <Box as="span" className="algo-viz-expand-cue" aria-hidden>
        ⤢ Expand
      </Box>
    </Box>
  );
}

/**
 * The full in-canvas animation (#3205) — rendered in GraphCanvas's `overlays` slot so it COVERS THE GRAPH
 * (not the rail/inspector) and never pans/zooms, exactly like the Components theme try-on (#2834). A large
 * player with full controls + the editable "provide your own state" input; a valid Run rebuilds the trace
 * from the user's input, an invalid one surfaces the error and keeps the last good run. `← Back to graph`
 * returns to the canvas.
 */
export function VizStage({ viz, implName, onBack }: { viz: VizExample; implName: string; onBack: () => void }) {
  const [text, setText] = useState(viz.input.default);
  const [error, setError] = useState<string | null>(null);
  // The current trace factory: the example default, swapped to a fresh closure on each valid Run. Storing
  // a function in state needs the double-arrow form (useState/set treat a bare function as an initializer/
  // updater) — a new identity re-memoizes the player's stream, i.e. a fresh replay from frame 0.
  const [factory, setFactory] = useState<() => Generator<Frame>>(() => viz.factory);

  const run = useCallback(() => {
    try {
      const parsed = viz.input.parse(text);
      const next = () => viz.input.make(parsed);
      setFactory(() => next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [text, viz]);

  return (
    // Cover the canvas (inset:0) above the graph; stopPropagation keeps clicks off the canvas pan/deselect
    // wiring (mirrors the Designs try-on overlay). cursor:default — the pannable canvas is covered here.
    <Box
      className="algo-viz-stage"
      role="group"
      aria-label={`Visualization — ${implName}`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 5,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-canvas, var(--bg))",
        cursor: "default",
      }}
    >
      <Row align="center" gap={12} className="algo-viz-stage-head">
        <Button variant="ghost" onClick={onBack}>
          ← Back to graph
        </Button>
        <Eyebrow size={9.5}>Visualization</Eyebrow>
        <Text weight={600} size={13}>
          {implName}
        </Text>
      </Row>

      <Box className="algo-viz-stage-body">
        <TracePlayer factory={factory} renderers={viz.renderers} fps={4} autoPlay loop controls />
      </Box>

      <Stack gap={8} className="algo-viz-stage-state">
        <Row gap={8} align="end">
          <Box style={{ flex: 1, minWidth: 0 }}>
            <TextField
              label="Your input"
              value={text}
              onChange={setText}
              hint={viz.input.hint}
              spellCheck={false}
              autoComplete="off"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  run();
                }
              }}
            />
          </Box>
          <Button onClick={run}>Run</Button>
        </Row>
        {error ? (
          <InlineError>{error}</InlineError>
        ) : (
          <Text size={11} tone="dim">
            Edit the input and Run to visualize your own state.
          </Text>
        )}
      </Stack>
    </Box>
  );
}
