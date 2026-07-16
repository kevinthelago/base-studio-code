// The generic trace player (#3176, epic #3171) — the ONE React driver over the streaming engine
// (`makeTraceStream`) and the pluggable renderer registry. It drives the stream at play speed, exposes
// play/pause/step-back/step-forward + a scrubber, and lays the frame's named panels side by side, each
// dispatched to its structure's renderer (or the fallback). Every per-structure renderer (#3178–#3185)
// plugs in via the injected `renderers` map — this component never changes as they land.
//
// Animation TIMING is intentionally simple: a `setInterval` tick that pulls one frame per beat. The
// STRUCTURE animations themselves are the kit's state-triggered motion (#3058), fired by the `data-op` /
// `data-mark` states each renderer stamps (see lib/binding.ts) — not driven from here.

import { createElement, useCallback, useEffect, useMemo, useState } from "react";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { normalizeFrame, type Frame, type StructureFrame } from "../lib/trace";
import { makeTraceStream } from "../lib/traceStream";
import { resolveRenderer, type RendererRegistry } from "./registry";
import "./tracePlayer.css";

export interface TracePlayerProps {
  /** Produces a fresh trace generator from the algorithm's fixed input. MEMOIZE this at the call site
   *  (a stable identity) — a new factory rebuilds the stream (a fresh replay from frame 0). */
  factory: () => Generator<Frame>;
  /** The per-structure renderers to dispatch panels to. Omitted/partial → the fallback renderer covers
   *  any unregistered structure. */
  renderers?: RendererRegistry;
  /** Scrub-back window passed to the stream (frames). Default is the engine's {@link makeTraceStream}. */
  bufferSize?: number;
  /** Playback speed — frames per second. Default 4 (watchable; the viz teaches, it doesn't benchmark). */
  fps?: number;
  /** Start playing on mount (and on every stream re-init) instead of paused (#3199) — the inline preview
   *  is alive like a component thumbnail, no click needed. Default false (the fullscreen player). */
  autoPlay?: boolean;
  /** On reaching the end, seek back to frame 0 and keep playing (#3199) — a continuous loop for the inline
   *  preview. Default false (the fullscreen player stops at the end so the user can scrub). */
  loop?: boolean;
  /** Render the play/step/scrub control bar. Default true; the compact inline preview passes false so it's
   *  just the moving picture (#3199). */
  controls?: boolean;
}

/** One panel: dispatch its frame to the registered renderer for its structure, or the fallback. Uses
 *  `createElement` (not `<Renderer/>`) so the dynamic dispatch isn't read as creating a component during
 *  render (react-hooks/static-components) — `resolveRenderer` returns an EXISTING, stable component. */
function PanelView({ name, frame, renderers }: { name: string; frame: StructureFrame; renderers: RendererRegistry }) {
  const renderer = resolveRenderer(renderers, frame.structure);
  return (
    <Stack gap={6} className="trace-panel">
      <Eyebrow size={10}>
        {name} · {frame.structure}
      </Eyebrow>
      {createElement(renderer, { frame })}
    </Stack>
  );
}

export function TracePlayer({ factory, renderers = {}, bufferSize, fps = 4, autoPlay = false, loop = false, controls = true }: TracePlayerProps) {
  const stream = useMemo(() => makeTraceStream(factory, { bufferSize }), [factory, bufferSize]);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [index, setIndex] = useState(-1);
  const [maxIndex, setMaxIndex] = useState(-1); // highest index reached — the scrubber's known extent
  const [playing, setPlaying] = useState(false);

  // Reflect the imperative stream cursor into React state (frame content + index + known extent).
  const sync = useCallback(() => {
    const i = stream.index();
    setIndex(i);
    setFrame(stream.current());
    setMaxIndex((m) => Math.max(m, i));
  }, [stream]);

  // Show the first frame whenever the stream (re)initializes; auto-play when asked (#3199 inline preview).
  useEffect(() => {
    stream.seek(0);
    sync();
    setPlaying(autoPlay);
  }, [stream, sync, autoPlay]);

  // The play loop: pull one frame per beat. At the end, loop back to 0 (#3199 inline preview) or stop.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const f = stream.next();
      if (f == null) {
        // Reached the end: restart from frame 0 when looping, else stop and hold the final frame.
        if (loop) {
          stream.seek(0);
          sync();
        } else {
          sync();
          setPlaying(false);
        }
      } else {
        sync();
      }
    }, Math.max(1, Math.round(1000 / fps)));
    return () => clearInterval(id);
  }, [playing, stream, sync, fps, loop]);

  const stepForward = useCallback(() => {
    setPlaying(false);
    stream.next();
    sync();
  }, [stream, sync]);

  const stepBack = useCallback(() => {
    setPlaying(false);
    stream.seek(Math.max(0, stream.index() - 1));
    sync();
  }, [stream, sync]);

  const scrub = useCallback(
    (i: number) => {
      setPlaying(false);
      stream.seek(i);
      sync();
    },
    [stream, sync],
  );

  const panels = frame ? normalizeFrame(frame) : {};
  const entries = Object.entries(panels);
  const scrubberMax = Math.max(0, maxIndex);

  return (
    <Stack gap={12} className="trace-player">
      <Row gap={12} wrap className="trace-panels">
        {entries.length === 0 ? (
          <Text size={12} tone="muted">
            No frames.
          </Text>
        ) : (
          entries.map(([name, panel]) => (
            <PanelView key={name} name={name} frame={panel} renderers={renderers} />
          ))
        )}
      </Row>

      {controls && (
        <Row gap={8} className="trace-controls">
          <IconButton aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying((p) => !p)}>
            {playing ? "⏸" : "▶"}
          </IconButton>
          <IconButton aria-label="Step back" onClick={stepBack} disabled={index <= 0}>
            ⏮
          </IconButton>
          <IconButton aria-label="Step forward" onClick={stepForward} disabled={stream.atEnd()}>
            ⏭
          </IconButton>
          {/* eslint-disable-next-line no-restricted-syntax -- range scrubber; no shared primitive for <input type="range"> */}
          <input
            className="trace-scrubber"
            type="range"
            aria-label="Scrub"
            min={0}
            max={scrubberMax}
            value={Math.max(0, index)}
            onChange={(e) => scrub(Number(e.currentTarget.value))}
          />
          <Text mono size={11} tone="dim">
            {index < 0 ? "—" : index} / {scrubberMax}
          </Text>
        </Row>
      )}
    </Stack>
  );
}
