// Preview review loop (#2623 slice 5) — the PURE decision core. During the in-graph preview the user
// walks the finished app; each captured SHOT (a screenshot + a label of what they navigated to) is sent
// to Claude, which returns FINDINGS. Findings land in a CONFIRM-GATED inbox: nothing is routed to the
// fleet until the USER confirms it (the reviewer PROPOSES, the user DISPOSES — mirrors user-only-confirms).
// A confirmed finding becomes a director DISPATCH (bsc-issue → bsc-assign), the same path faultTriage
// (#2265) routes runtime faults, so the maintenance fleet fixes it.
//
// Kept React/Tauri-free so the loop's guarantees are unit-tested in isolation:
//   • DEDUP    — the same finding for the same shot never enters the inbox twice (idempotent re-review).
//   • GATE     — only USER-confirmed findings are dispatchable; pending/dismissed never route.
//   • PARSE    — Claude's reply is coerced tolerantly (code fences / stray prose can't crash the loop).

export type ReviewSeverity = "polish" | "issue" | "blocker";

/** One screen the user captured during the preview walkthrough. */
export interface PreviewShot {
  id: string;
  /** What the user was looking at — a route/path or a free label. */
  label: string;
  /** The captured frame as a data URL (`data:image/png;base64,…`); the multimodal review attaches it. */
  image: string;
}

/** One thing Claude flagged about a shot. `status` is the confirm gate — the finding is inert until the
 *  user confirms it. */
export interface ReviewFinding {
  id: string;
  shotId: string;
  severity: ReviewSeverity;
  title: string;
  detail: string;
  status: "pending" | "confirmed" | "dismissed" | "routed";
}

const SEVERITY_RANK: Record<ReviewSeverity, number> = { polish: 1, issue: 2, blocker: 3 };
function rank(s: ReviewSeverity): number {
  return SEVERITY_RANK[s] ?? 0;
}

/** The stable identity of a finding — its shot + its normalized title. Two reviews of the same shot that
 *  surface the same problem collapse to one inbox row (so re-reviewing doesn't duplicate). */
export function findingKey(f: Pick<ReviewFinding, "shotId" | "title">): string {
  return `${f.shotId}::${f.title.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

/**
 * Fold freshly-parsed findings into the existing inbox. Pure + order-stable.
 *  - DEDUP: a finding whose {@link findingKey} already exists is dropped (the existing row — and its
 *    user-set status — wins), so re-reviewing a shot never resurrects a dismissed finding or duplicates a
 *    confirmed one.
 *  - New findings are appended in arrival order with `status: "pending"`.
 */
export function mergeFindings(existing: ReviewFinding[], incoming: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set(existing.map(findingKey));
  const fresh: ReviewFinding[] = [];
  for (const f of incoming) {
    const key = findingKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push({ ...f, status: "pending" });
  }
  return [...existing, ...fresh];
}

/** Transition one finding's confirm-gate status (confirm / dismiss / re-open). Pure — returns a new list. */
export function setFindingStatus(
  findings: ReviewFinding[],
  id: string,
  status: ReviewFinding["status"],
): ReviewFinding[] {
  return findings.map((f) => (f.id === id ? { ...f, status } : f));
}

/** Findings still awaiting the user's decision (worst first). */
export function pendingFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.filter((f) => f.status === "pending").sort((a, b) => rank(b.severity) - rank(a.severity));
}

/** The user-confirmed findings — the ONLY ones eligible to dispatch to the fleet. Once routed they move
 *  to `routed` (see {@link routedFindings}) so they drop out here and can't be dispatched twice. */
export function confirmedFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.filter((f) => f.status === "confirmed").sort((a, b) => rank(b.severity) - rank(a.severity));
}

/** Findings already routed to the fleet (dispatched) — surfaced as a tally, never re-dispatched. */
export function routedFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.filter((f) => f.status === "routed");
}

/** The system prompt for the one-shot review call — a terse UI reviewer that MUST answer as strict JSON. */
export function reviewSystemPrompt(): string {
  return [
    "You are a meticulous UI/UX reviewer looking at one screen of a finished application the user is",
    "previewing. Report only concrete, actionable problems you can SEE in the screenshot — layout breaks,",
    "misalignment, contrast/legibility, overflow/clipping, inconsistent spacing, obvious broken or empty",
    "states. Do not invent behavior you can't observe. Prefer few high-signal findings over many nits.",
    "",
    'Answer with ONLY a JSON array (no prose, no code fence): [{"severity","title","detail"}]. severity is',
    'one of "polish" | "issue" | "blocker". title ≤ 8 words. detail is one sentence naming the fix. Return',
    "[] when the screen looks good.",
  ].join("\n");
}

/** The user-message text for the review of one shot (the screenshot image is attached alongside it by the
 *  multimodal caller — slice 5c). */
export function reviewUserPrompt(shot: Pick<PreviewShot, "label">): string {
  return `Screen: ${shot.label || "(app)"}. Review this screen and report findings as the JSON array.`;
}

/** Parse Claude's review reply into findings for `shotId`. Tolerant: strips a ```json fence, finds the
 *  first JSON array, and coerces each entry — an unparseable / non-array reply yields `[]` (never throws),
 *  so a bad review can't break the loop. `idFor(i)` mints each finding's id (pass a stable minter). */
export function parseFindings(raw: string, shotId: string, idFor: (i: number) => string): ReviewFinding[] {
  const arr = extractJsonArray(raw);
  if (!arr) return [];
  const out: ReviewFinding[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const title = typeof e.title === "string" ? e.title.trim() : "";
    if (!title) continue;
    out.push({
      id: idFor(out.length),
      shotId,
      severity: coerceSeverity(e.severity),
      title,
      detail: typeof e.detail === "string" ? e.detail.trim() : "",
      status: "pending",
    });
  }
  return out;
}

function coerceSeverity(v: unknown): ReviewSeverity {
  return v === "blocker" || v === "issue" || v === "polish" ? v : "issue";
}

/** Find the first top-level JSON array in a model reply (handles a leading code fence or stray prose). */
function extractJsonArray(raw: string): unknown[] | null {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The director-facing message routing the user-confirmed findings to the fleet — one paste covers the
 *  batch; the director runs `bsc-issue` (capture) → `bsc-assign` (route to the owning worker) per its
 *  protocol, exactly like the fault-triage dispatch (#2265). `shotLabel` maps a shotId → its screen label. */
export function reviewDispatchPrompt(
  confirmed: ReviewFinding[],
  shotLabel: (shotId: string) => string,
): string {
  const lines = confirmed
    .map((f) => `• [${f.severity}] ${f.title} — ${f.detail} (screen: ${shotLabel(f.shotId) || "app"})`)
    .join("\n");
  return [
    "[preview-review] The user reviewed the running app and CONFIRMED these UI findings — route a fix for each:",
    lines,
    "For each finding: capture it with `bsc-issue` (the title + detail above), then `bsc-assign <session>` " +
      "the worker whose `owns` lane covers that screen (open a GitHub issue first if it should be tracked). " +
      "Close the loop when the fix merges to develop.",
  ].join("\n");
}
