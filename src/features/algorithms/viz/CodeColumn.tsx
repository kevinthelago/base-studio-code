// The code column beside the animation (#3250, epic #3230/#3215) — the trace-program's source with the
// span of the CURRENTLY EXECUTING op lit up.
//
// PER-OP, NOT PER-LINE. The player advances one frame per op, and one line routinely carries two of them
// (`if (a.compare(j - 1, j) <= 0) break; a.swap(j - 1, j);`). Highlighting the LINE would sit frozen across
// two distinct beats and lose the rhythm the animation is teaching; highlighting the CALL moves on every
// beat, so the code and the picture step together. That is why `Frame.loc` is a character range, not a line
// number — the line is carried only for the readout.

import { useEffect, useRef } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import type { SourceRange } from "../lib/trace";
import "./codeColumn.css";

export interface CodeColumnProps {
  /** The trace-program source — the exact string {@link loc} indexes into (`VizRun.source`). */
  source: string;
  /** The executing op's range, or `undefined` for a frame with no provenance (the at-rest opening frame,
   *  or an uninstrumented program) — then the source renders with nothing lit. */
  loc?: SourceRange;
}

/**
 * Split `source` at `loc` into the before / highlighted / after segments.
 *
 * Ranges are CLAMPED to the source bounds and an inverted or empty range is discarded, so a stale or
 * malformed `loc` degrades to "nothing highlighted" rather than throwing inside the player. Exported for
 * the test — this is the whole pure model of the component.
 */
export function splitAtLoc(source: string, loc?: SourceRange): { before: string; hit: string; after: string } {
  if (!loc) return { before: source, hit: "", after: "" };
  const start = Math.max(0, Math.min(loc.start, source.length));
  const end = Math.max(start, Math.min(loc.end, source.length));
  if (end === start) return { before: source, hit: "", after: "" };
  return { before: source.slice(0, start), hit: source.slice(start, end), after: source.slice(end) };
}

/** The source pane beside the animation: the whole trace-program, with the executing op's span marked. */
export function CodeColumn({ source, loc }: CodeColumnProps) {
  const { before, hit, after } = splitAtLoc(source, loc);
  const markRef = useRef<HTMLElement | null>(null);

  // Follow the highlight as the animation walks the program, so a long program does not step off-screen.
  // `scrollIntoView` is not implemented in jsdom (and absent in some embedded WebViews) — a missing or
  // throwing implementation must never take down the player, so the call is fully defensive.
  useEffect(() => {
    if (!hit) return;
    try {
      markRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    } catch {
      /* no scrolling available — the highlight is still rendered, which is the load-bearing part */
    }
  }, [hit, loc?.start]);

  return (
    <Stack gap={6} className="algo-code-column">
      <Row gap={8} align="center">
        <Eyebrow size={10}>source</Eyebrow>
        {loc ? (
          <Text mono size={10.5} tone="dim">
            line {loc.line}
          </Text>
        ) : null}
      </Row>
      <Box as="pre" className="algo-code-pre" aria-label="Trace-program source">
        <code>
          {before}
          {hit ? (
            // `data-op-span` is the hook the test asserts on and the animation-timed highlight styles.
            <mark ref={markRef} className="algo-code-hit" data-op-span="">
              {hit}
            </mark>
          ) : null}
          {after}
        </code>
      </Box>
    </Stack>
  );
}
