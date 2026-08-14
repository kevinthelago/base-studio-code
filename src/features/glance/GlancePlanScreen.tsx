// A worker's PLAN — the issues it owns (#4102).
//
// The third screen of an open agent node, beside Stream and Logs. Stream shows what the agent is
// SAYING and Logs what it EMITTED; neither answers "what is this worker actually responsible for".
// That question was only answerable by reading its kickoff or the plan.db by hand.
//
// ── WHERE THE DATA COMES FROM ───────────────────────────────────────────────────────────────────
// Ownership is LOCAL: `AgentStream.issues` carries the refs, so the list renders with no network and
// no token. GitHub is an OVERLAY supplying only open/closed (#2444: render local-first, never
// token-gate). A disconnected user still sees exactly which issues are theirs — they just don't get
// the state chips, and the screen says so rather than showing a silent, confident zero.
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { normalizeRef } from "@/features/glance/lib/fleetPlanProgress";
import type { StreamProgress } from "@/features/glance/lib/streamProgress";

export interface PlanScreenIssue {
  /** As stored, e.g. `#3898` — shown verbatim so it matches the plan and the board. */
  ref: string;
  /** `true` closed, `false` open, `undefined` when the overlay could not resolve it. */
  closed?: boolean;
}

/** Join a stream's refs to what is known about each one. Pure + exported so the join is testable
 *  without a render.
 *
 *  TWO SOURCES, plan.db first. plan.db is the store of record and needs no token, so when it has a row
 *  for a ref its status is the answer; the GitHub overlay only fills refs plan.db has never heard of.
 *  This is the same both-sources principle the node's progress bar already uses (`unionDone`) — the
 *  per-row list simply never got it, which is how a bar could read 3/7 while all seven rows said
 *  "state unknown".
 *
 *  Order is the PLAN's order, not sorted by state: the plan sequences a worker's work, and re-sorting
 *  it (done-first, say) would quietly hide that sequence. */
export function planScreenIssues(
  refs: readonly string[],
  states: ReadonlyMap<string, boolean>,
  planClosed?: ReadonlyMap<string, boolean>,
): PlanScreenIssue[] {
  const seen = new Set<string>();
  const out: PlanScreenIssue[] = [];
  for (const ref of refs) {
    const key = normalizeRef(ref);
    if (seen.has(key)) continue;      // a ref listed twice is one issue, not two
    seen.add(key);
    // Look plan.db up by BOTH the raw ref and its normalised form: plan.db refs are stored verbatim
    // (`4260-sandbox-…`, or `#3898` in an older plan), while the overlay is keyed by the normalised
    // number. Checking only one of them would miss whichever spelling the project happens to use.
    const local = planClosed?.get(ref) ?? planClosed?.get(key);
    out.push({ ref, closed: local ?? states.get(key) });
  }
  return out;
}

/** `3/7` — the same counts the node's bar renders, so the two can never disagree. */
export function progressLabel(p: StreamProgress | undefined): string {
  return p && p.total > 0 ? `${p.done}/${p.total}` : "";
}

export function GlancePlanScreen({
  issues, progress, unresolved, loading,
}: {
  issues: readonly PlanScreenIssue[];
  progress?: StreamProgress;
  /** The overlay is unavailable (no token / fetch failed), so states are unknown. */
  unresolved?: boolean;
  loading?: boolean;
}) {
  if (issues.length === 0) {
    return (
      <Box style={{ padding: "18px 16px" }}>
        <Text as="div" size={12.5} tone="muted" style={{ lineHeight: 1.6, maxWidth: 380 }}>
          This worker owns no issues in the plan. It runs as a standing agent — the director assigns it
          work directly rather than from a planned list.
        </Text>
      </Box>
    );
  }

  const label = progressLabel(progress);

  return (
    <Box style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Row justify="between" align="center" style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", flex: "none" }}>
        <Text mono size="xs" tone="dim">OWNED ISSUES</Text>
        {label ? <Text mono size="xs" tone="dim">{label}</Text> : null}
      </Row>

      {/* The bar is repeated here deliberately: at graph zoom the node's own 3px edge fill is often
          unreadable, and this screen is where a user comes for the detail. Same counts, one source. */}
      {progress && progress.total > 0 ? (
        <Box aria-hidden style={{ height: 3, background: "var(--border)", flex: "none" }}>
          <Box style={{
            width: `${(progress.done / progress.total) * 100}%`, height: "100%",
            background: "var(--accent)", transition: "width 220ms ease",
          }} />
        </Box>
      ) : null}

      <Box style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {issues.map((i) => {
          // Three distinct states, and they must LOOK distinct: closed, open, and unknown. Rendering
          // "unknown" as open would be the same class of confident-wrong the progress bar avoids.
          const glyph = i.closed === undefined ? "·" : i.closed ? "✓" : "○";
          const color = i.closed === undefined
            ? "var(--fg-muted)"
            : i.closed ? "var(--accent)" : "var(--fg)";
          return (
            <Row
              key={i.ref}
              gap="sm"
              align="center"
              style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-subtle, var(--border))" }}
            >
              <Text as="span" mono size="xs" aria-hidden style={{ color, flex: "none", width: 12 }}>{glyph}</Text>
              <Text
                as="span" mono size="xs"
                style={{ flex: "none", color, textDecoration: i.closed ? "line-through" : undefined }}
              >
                {i.ref}
              </Text>
              <Text as="span" size="xs" tone="dim" style={{ flex: "none" }}>
                {i.closed === undefined ? (loading ? "checking…" : "state unknown") : i.closed ? "closed" : "open"}
              </Text>
            </Row>
          );
        })}
      </Box>

      {/* Only ask for GitHub when it would actually add something: the overlay is unavailable AND some
          row is still unknown after plan.db answered. A project that tracks its work locally resolves
          every row from plan.db, and telling that user to connect GitHub would be advice to fix
          nothing. Derived from the rendered rows, so the note cannot contradict what is on screen. */}
      {unresolved && issues.some((i) => i.closed === undefined) ? (
        <Box style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", flex: "none" }}>
          <Text as="div" size="xs" tone="dim" style={{ lineHeight: 1.5 }}>
            Connect GitHub to see which of these are closed. The list above is the plan and is always accurate.
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
