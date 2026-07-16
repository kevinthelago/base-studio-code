// VizPanel (#3199) — the Algorithms inspector's visualization surface. Replaces the old Code |
// Visualization toggle: the animation is ALWAYS rendered inline as a compact, auto-playing, looping
// preview (like a component thumbnail on the Components page), and clicking it FILLS THE SCREEN with a
// full player + an editable "provide your own state" input. Mirrors the Design Studio's
// ComponentPreviewFrame `onExpand` pattern.
import { useCallback, useState } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { Button } from "@/shared/ui/controls/Button";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { TextField } from "@/shared/ui/controls/Field";
import { InlineError } from "@/shared/ui/feedback/InlineError";
import { ModalScrim } from "@/shared/ui/overlay/ModalScrim";
import type { Frame } from "../lib/trace";
import { TracePlayer } from "./TracePlayer";
import type { VizExample } from "./examples/registry";
import "./vizPanel.css";

/**
 * The always-on visualization for a focused impl (#3199). Renders the compact inline preview and owns the
 * fullscreen open state — this is the single entry the inspector mounts (no toggle).
 */
export function VizPanel({ viz }: { viz: VizExample }) {
  const [full, setFull] = useState(false);
  return (
    <>
      <VizPreview viz={viz} onExpand={() => setFull(true)} />
      {full && <VizFullscreen viz={viz} onClose={() => setFull(false)} />}
    </>
  );
}

/** The compact inline preview — a controls-less, auto-playing, looping player wrapped in a clickable
 *  affordance (hover/focus surfaces an expand cue) that fills the screen on activate. */
function VizPreview({ viz, onExpand }: { viz: VizExample; onExpand: () => void }) {
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

/** The fill-screen view — a large player with full controls + the editable "provide your own state"
 *  field. A valid Run rebuilds the trace from the user's input; an invalid one surfaces the error and
 *  keeps the last good run. */
function VizFullscreen({ viz, onClose }: { viz: VizExample; onClose: () => void }) {
  const [text, setText] = useState(viz.input.default);
  const [error, setError] = useState<string | null>(null);
  // The current trace factory: starts on the example default, swapped to a fresh closure on each valid
  // Run. Storing a function in state needs the double-arrow form (useState/ set treat a bare function as
  // an initializer/updater) — the STORED value is the factory itself. A new identity re-memoizes the
  // player's stream, i.e. a fresh replay from frame 0.
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
    <ModalScrim onDismiss={onClose} blur className="algo-viz-scrim">
      <Stack gap={0} className="algo-viz-fullscreen" role="dialog" aria-label="Visualization" aria-modal>
        <Row align="center" gap={8} className="algo-viz-fullscreen-head">
          <Eyebrow size={11}>Visualization</Eyebrow>
          <Box style={{ flex: 1 }} />
          <IconButton aria-label="Close" onClick={onClose}>
            ✕
          </IconButton>
        </Row>

        <Box className="algo-viz-fullscreen-stage">
          <TracePlayer factory={factory} renderers={viz.renderers} fps={4} autoPlay controls />
        </Box>

        <Stack gap={8} className="algo-viz-state">
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
      </Stack>
    </ModalScrim>
  );
}
