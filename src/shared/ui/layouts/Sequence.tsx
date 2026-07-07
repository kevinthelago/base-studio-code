// Sequence — the Layouts-tier template for linked-list-shaped data (#2477, epic #2197): workflows,
// pipelines, wizards, timelines — any page where the ORDER between nodes is the first-class thing.
// An ordered, status-colored step STRIP (nodes joined by directional prev→next connectors) drives an
// active-step DETAIL panel, under an optional TOOLBAR. Two variants: "horizontal" (a pipeline/stepper
// strip above the detail) and "vertical" (a timeline rail beside it). The strip scrolls within its
// own container (x when horizontal, y when vertical), so a long sequence never blows out the page.
//
// Selection is controlled (`selectedId` + `onSelect`) or uncontrolled — internal state seeded by
// `defaultSelectedId`, else auto-following the `active` step (the planner focused-pane idiom: the
// page tracks the live step until the user clicks elsewhere). Pure presentational: callers map their
// own model into ordered `SequenceStep`s; the per-step status vocabulary (complete / active /
// upcoming / blocked) and the node/connector look mirror the planner stepper's ProgressionRail.
// Sits on the layout primitives (Box/Row/Stack) in the same inline-style/token idiom; the step /
// node / connector visual language lives in sequence.css (imported here so every consumer gets it).
import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import type { Space } from "@/shared/ui/layout/space";
import "./sequence.css";

/** Per-step status — complete (done, filled ✓), active (the live step, accent-ringed), upcoming
 *  (not reached, dim), blocked (can't proceed, danger-ringed !). */
export type SequenceStatus = "complete" | "active" | "upcoming" | "blocked";

export interface SequenceStep {
  /** Stable identity — drives selection and React keys. */
  id: string;
  label: string;
  /** Default "upcoming". */
  status?: SequenceStatus;
  /** Secondary meta line — rendered under the label in the vertical timeline; the hover tooltip in both. */
  hint?: string;
}

export interface SequenceProps {
  /** The ordered steps — array order IS the sequence order (prev → next). */
  steps: SequenceStep[];
  /** The focus panel — a render prop receiving the focused step. Omit for a strip-only sequence. */
  detail?: (step: SequenceStep) => ReactNode;
  /** "horizontal" (default) → stepper strip above the detail; "vertical" → timeline rail beside it. */
  orientation?: "horizontal" | "vertical";
  /** Optional full-width toolbar/header above the sequence (title, actions). */
  toolbar?: ReactNode;
  /** Controlled focused step id (pair with onSelect). Omit for uncontrolled selection. */
  selectedId?: string;
  /** Uncontrolled initial focus — defaults to auto-following the `active` step, else the first. */
  defaultSelectedId?: string;
  /** Fires with the clicked step's id (both modes). */
  onSelect?: (id: string) => void;
  /** Timeline rail width in px (vertical only). Default 260. */
  railWidth?: number;
  /** Detail inner padding — a space rung or [block, inline]. Default 20. */
  detailPad?: Space | [Space, Space];
  /** Escape hatch for a deliberate strip/rail override. */
  stripStyle?: CSSProperties;
  /** Escape hatch for a deliberate detail override. */
  detailStyle?: CSSProperties;
  /** Extra class on the root (a page scoping hook). */
  className?: string;
}

/** A done node shows ✓, a blocked one !, anything else its 1-based position — the ring/fill color
 *  (sequence.css) carries the rest of the status. */
function nodeContent(status: SequenceStatus, index: number): ReactNode {
  return status === "complete" ? "✓" : status === "blocked" ? "!" : index + 1;
}

export function Sequence({
  steps, detail, orientation = "horizontal", toolbar,
  selectedId, defaultSelectedId, onSelect,
  railWidth = 260, detailPad = 20, stripStyle, detailStyle, className,
}: SequenceProps) {
  const vertical = orientation === "vertical";
  const controlled = selectedId !== undefined;
  const [internalId, setInternalId] = useState(defaultSelectedId);
  const focusId = controlled ? selectedId : internalId;
  // Resolve by id; a missing/stale id degrades to the live `active` step, else the first — so an
  // uncontrolled Sequence with no clicks auto-follows the active step as it advances.
  const focused = steps.find((s) => s.id === focusId)
    ?? steps.find((s) => s.status === "active")
    ?? steps[0];

  const select = (id: string) => {
    if (!controlled) setInternalId(id);
    onSelect?.(id);
  };

  const dir = vertical ? "seq-v" : "seq-h";
  const strip = (
    <Box className={`seq-strip ${dir}`} style={{
      background: "var(--bg-panel)",
      ...(vertical
        ? { flex: `0 0 ${railWidth}px`, width: railWidth, overflowY: "auto", borderRight: "1px solid var(--border-soft)" }
        : { flex: "none", overflowX: "auto", borderBottom: "1px solid var(--border-soft)" }),
      ...stripStyle,
    }}>
      <Box className={`seq-track ${dir}`}>
        {steps.map((s, i) => {
          const status = s.status ?? "upcoming";
          const isFocused = focused?.id === s.id;
          return (
            <Fragment key={s.id}>
              <button
                type="button"
                className={`seq-step ${status}${isFocused ? " sel" : ""}`}
                title={s.hint ?? s.label}
                aria-current={isFocused ? "step" : undefined}
                onClick={() => select(s.id)}
              >
                <Box as="span" className={`seq-node ${status}`}>{nodeContent(status, i)}</Box>
                <Box as="span" className="seq-text">
                  <Box as="span" className="seq-label">{s.label}</Box>
                  {vertical && s.hint && <Box as="span" className="seq-hint">{s.hint}</Box>}
                </Box>
              </button>
              {/* The prev→next affordance: an arrowed connector, solid success AFTER a completed
                  node, else dim (the ProgressionRail 2-state connector). */}
              {i < steps.length - 1 && (
                <Box as="span" aria-hidden="true" className={`seq-conn ${status === "complete" ? "solid" : "dim"}`} />
              )}
            </Fragment>
          );
        })}
      </Box>
    </Box>
  );

  // The active-step focus panel — only when the page brings detail content.
  const focusPanel = detail ? (
    <Box className="seq-detail" pad={detailPad} style={{
      flex: 1, minWidth: 0, minHeight: 0, overflow: "auto",
      display: "flex", flexDirection: "column", ...detailStyle,
    }}>
      {focused && detail(focused)}
    </Box>
  ) : null;

  // Fills the <Screen> body; the toolbar (if any) sits above, matching the other templates.
  return (
    <Stack gap={0} className={className} style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
      {toolbar}
      {vertical ? (
        <Row gap={0} align="stretch" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          {strip}
          {focusPanel}
        </Row>
      ) : (
        <>
          {strip}
          {focusPanel}
        </>
      )}
    </Stack>
  );
}
