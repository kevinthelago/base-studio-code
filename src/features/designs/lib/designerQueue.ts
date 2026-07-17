// The overnight designer loop's AUTO-QUEUE (#3311, epic #3260) — the pure "what to work on next" core.
// React-free + side-effect-free so it's unit-testable: the pump (a later slice) runs `bsc ui …
// --coverage`/`bsc ui resolve` and feeds the parsed reports here; this ranks the design system's own
// HONEST gaps into an ordered directive list the driver dispatches one-per-turn.
//
// GROUND-TRUTH FIRST. Objective findings (measured coverage gaps + real-pixel shots) rank ahead of
// open-ended polish, so the loop fixes what's demonstrably wrong before it starts "improving" on taste —
// the guard against a signal-less loop that agrees with anything (#3262). When the objective findings
// drain, the loop stops (a GOOD outcome: "nothing left to fix") unless motion/polish keep it going.

/** A single piece of direction the driver hands the designer. */
export type DirectiveKind =
  | "leak" //          a hardcoded color a token change can't reach (highest: demonstrably ungoverned)
  | "uncontracted" //  a consumed token the contract doesn't define (structural gap)
  | "theme-miss" //    a consumed token left at its contract default under the active theme
  | "low-coverage" //  a component consuming fewer tokens than it could (won't retint fully)
  | "dead-token" //    a contract token no component consumes (use or retire)
  | "motion" //        review/refine a component's animation (grounded by a --frames burst)
  | "polish"; //       a rotating high-level directive that sustains the run once findings drain

export interface DesignDirective {
  /** Stable-ish id (so a pump can dedup / log across rebuilds). */
  id: string;
  kind: DirectiveKind;
  /** Short human title (the driver's `bsc loop say` summary). */
  title: string;
  /** The specific instruction, grounded in the finding — what to change and why. */
  detail: string;
  /** The token / component / file the directive concerns (absent for a generic polish directive). */
  target?: string;
}

/** The `bsc ui components --coverage --json` fields the queue reads. */
export interface CoverageReport {
  /** Hardcoded colors a token change can't reach, per file (`{file, count}`). */
  leakCandidates: { file: string; count: number }[];
  /** Contract tokens NO component consumes. */
  zeroConsumers: string[];
  /** Per-component token consumption. */
  components: { component: string; tokensConsumed: number; tokensTotal: number }[];
}

/** The `bsc ui resolve --json` fields the queue reads. */
export interface ResolveReport {
  theme?: string;
  /** Consumed tokens the theme leaves at their contract default (the fall-loudly gap). */
  themeMisses: string[];
  /** Consumed tokens the contract does NOT define. */
  uncontracted: string[];
  complete?: boolean;
}

export interface QueueInput {
  coverage?: CoverageReport | null;
  resolve?: ResolveReport | null;
  /** The kit's components, for the motion directives (+ role, to skip pages — they animate parent-side). */
  components?: { id: string; name: string; role?: string }[];
  /** Rotates the motion + polish start so a long run varies rather than always leading with the same one. */
  round?: number;
}

/** Last path segment of a `/`- or `\`-separated path (for a compact leak title). */
function short(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

/** Rotate `arr` left by `n` (wrapping), so successive rounds start at a different entry. Pure. */
function rotate<T>(arr: readonly T[], n: number): T[] {
  if (arr.length === 0) return [];
  const k = ((Math.trunc(n) % arr.length) + arr.length) % arr.length;
  return [...arr.slice(k), ...arr.slice(0, k)];
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/** Parse a `bsc ui components --coverage --json` reply tolerantly — a reply that isn't a coverage report
 *  (empty, an error object, a future shape) yields `null`, and malformed rows are dropped, never thrown. */
export function parseCoverage(json: unknown): CoverageReport | null {
  if (!isRecord(json)) return null;
  if (!("leakCandidates" in json) && !("zeroConsumers" in json) && !("components" in json)) return null;
  const leakCandidates = (Array.isArray(json.leakCandidates) ? json.leakCandidates : [])
    .filter((x): x is Record<string, unknown> => isRecord(x) && typeof x.file === "string" && typeof x.count === "number")
    .map((x) => ({ file: x.file as string, count: x.count as number }));
  const zeroConsumers = (Array.isArray(json.zeroConsumers) ? json.zeroConsumers : []).filter(
    (x): x is string => typeof x === "string",
  );
  const components = (Array.isArray(json.components) ? json.components : [])
    .filter(
      (x): x is Record<string, unknown> =>
        isRecord(x) && typeof x.component === "string" && typeof x.tokensConsumed === "number" && typeof x.tokensTotal === "number",
    )
    .map((x) => ({ component: x.component as string, tokensConsumed: x.tokensConsumed as number, tokensTotal: x.tokensTotal as number }));
  return { leakCandidates, zeroConsumers, components };
}

/** Parse a `bsc ui resolve --json` reply tolerantly (see {@link parseCoverage}). */
export function parseResolve(json: unknown): ResolveReport | null {
  if (!isRecord(json)) return null;
  if (!("themeMisses" in json) && !("uncontracted" in json)) return null;
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    theme: typeof json.theme === "string" ? json.theme : undefined,
    themeMisses: strArr(json.themeMisses),
    uncontracted: strArr(json.uncontracted),
    complete: typeof json.complete === "boolean" ? json.complete : undefined,
  };
}

/** The rotating polish directives — open-ended "keep improving" work that sustains a run once the
 *  objective findings drain. Deliberately last (subjective, no ground truth beyond the shot). */
const POLISH: { key: string; title: string; detail: string }[] = [
  { key: "hierarchy", title: "Sharpen visual hierarchy", detail: "Strengthen a component's visual hierarchy (size/weight/spacing) so its primary element reads first." },
  { key: "spacing", title: "Tighten spacing rhythm", detail: "Audit a component's spacing for one consistent scale — remove ad-hoc gaps so the rhythm reads deliberate." },
  { key: "contrast", title: "Raise weak contrast", detail: "Find a text-or-border-on-surface pair with weak contrast and lift it toward an accessible ratio via tokens." },
  { key: "states", title: "Complete interaction states", detail: "Pick a control and make hover/active/focus/disabled each read distinctly — as tokens/variants, not one-offs." },
];

/**
 * Build the ranked directive queue from the design system's own findings. Objective gaps first (leaks →
 * uncontracted → theme-misses → low-coverage → dead tokens), then motion (per component, so the loop
 * covers animations), then rotating polish. Pure — the same inputs always yield the same queue.
 */
export function buildDesignerQueue(inp: QueueInput): DesignDirective[] {
  const out: DesignDirective[] = [];
  const cov = inp.coverage ?? null;
  const res = inp.resolve ?? null;
  const comps = inp.components ?? [];
  const round = inp.round ?? 0;

  // 1 · LEAKS — hardcoded colors a token change literally can't reach. The migration's real targets.
  for (const l of cov?.leakCandidates ?? []) {
    if (l.count > 0) {
      out.push({
        id: `leak:${l.file}`,
        kind: "leak",
        target: l.file,
        title: `Replace hardcoded colors in ${short(l.file)}`,
        detail: `${l.file} has ${l.count} hardcoded color(s) the design system can't govern — replace them with theme tokens so a theme actually reaches them.`,
      });
    }
  }
  // 2 · UNCONTRACTED — a consumed token the contract doesn't define (a token the system can't govern).
  for (const t of res?.uncontracted ?? []) {
    out.push({
      id: `uncontracted:${t}`,
      kind: "uncontracted",
      target: t,
      title: `Bring token ${t} under the design system`,
      detail: `Token ${t} is consumed but uncontracted — add it to the contract so the theme can govern it instead of it drifting.`,
    });
  }
  // 3 · THEME MISSES — a consumed token left at its contract default under the active theme.
  for (const t of res?.themeMisses ?? []) {
    out.push({
      id: `theme-miss:${res?.theme ?? ""}:${t}`,
      kind: "theme-miss",
      target: t,
      title: `Give token ${t} a considered value`,
      detail: `Token ${t} sits at its contract default under theme ${res?.theme ?? "the active theme"} — set a deliberate value so the theme reads intentional, not fallen-through.`,
    });
  }
  // 4 · LOW COVERAGE — a component consuming fewer tokens than it could (won't retint fully).
  for (const c of cov?.components ?? []) {
    if (c.tokensTotal > 0 && c.tokensConsumed < c.tokensTotal) {
      out.push({
        id: `low-coverage:${c.component}`,
        kind: "low-coverage",
        target: c.component,
        title: `Wire ${c.component} to its tokens`,
        detail: `${c.component} consumes ${c.tokensConsumed}/${c.tokensTotal} of its tokens — wire the rest so it retints fully under a theme.`,
      });
    }
  }
  // 5 · DEAD TOKENS — contract tokens no component consumes (use them or retire them; keep it honest).
  for (const t of cov?.zeroConsumers ?? []) {
    out.push({
      id: `dead-token:${t}`,
      kind: "dead-token",
      target: t,
      title: `Use or retire token ${t}`,
      detail: `Token ${t} has no consumers — apply it where it belongs or retire it so the contract reflects what's real.`,
    });
  }
  // 6 · MOTION — one per component, so the loop covers ANIMATIONS (grounded by a --frames burst). Pages
  //     animate parent-side, so skip them. Rotated by `round` so a long run doesn't always start the same.
  const motionComps = comps.filter((c) => c.role !== "page");
  for (const c of rotate(motionComps, round)) {
    out.push({
      id: `motion:${c.id}`,
      kind: "motion",
      target: c.name,
      title: `Review the motion on ${c.name}`,
      detail: `Does ${c.name} have a considered entrance and interaction motion? Add or refine it, then capture the motion as a burst so the change is grounded.`,
    });
  }
  // 7 · POLISH — rotating high-level directives that sustain the run once objective findings drain.
  for (const p of rotate(POLISH, round)) {
    out.push({ id: `polish:${p.key}`, kind: "polish", title: p.title, detail: p.detail });
  }
  return out;
}
