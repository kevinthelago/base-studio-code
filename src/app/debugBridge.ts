// debugBridge (#3437, epic #3260) — the PURE half of `bsc debug`: turn an inspection request into a
// result, with every environment-dependent capability injected.
//
// WHY PURE + INJECTED
// The two facts this verb exists to report are exactly the two jsdom cannot produce: `elementFromPoint`
// (jsdom has no hit-testing at all) and a real `getBoundingClientRect` (jsdom returns zeros). If the
// logic reached for them directly, the module would be untestable and the shipped behavior would be
// pinned by nothing. Injecting them means the DECISIONS — is this element covered, which ancestor chain,
// how is a silent engine distinguished from an absent one — are unit-testable, and only the thin adapter
// (`useDebugChannel`) touches the real DOM.
//
// READ-ONLY BY CONSTRUCTION
// There is no branch here that evaluates caller-supplied code, and there must never be one: the whole
// point of the `designer` role (#2471) is that its writable surface is `bsc ui` alone, and an eval verb
// on the same binary would be a way around it. Every request is one of a closed set (see `DebugRequest`).
import type { PreviewFrameEntry } from "@/features/designs";

/** The wire request, mirroring the Rust `bsc_debug::DebugRequest` (serde tag = `op`). */
export type DebugRequest =
  | { op: "hit"; x: number; y: number }
  | { op: "probe"; selector: string; all?: boolean }
  | { op: "frames" };

/** One element's report — mirrors `bsc_debug::ElementInfo`. Snake_case: it crosses to Rust verbatim. */
export interface ElementInfo {
  label: string;
  rect: [number, number, number, number];
  styles: Record<string, string>;
  topmost_at_centre: boolean;
  covered_by?: string;
}

export interface EngineProbe {
  listening: boolean;
  transform: string;
  scale: number;
  pan: [number, number];
}

export interface FrameInfo {
  component: string;
  element: ElementInfo;
  engine_requested: boolean;
  engine_in_srcdoc: boolean;
  engine?: EngineProbe;
}

/** Mirrors `bsc_debug::DebugResult` (serde rename_all = lowercase, externally tagged). */
export type DebugResult =
  | { hit: { chain: ElementInfo[] } }
  | { probe: { matched: ElementInfo[] } }
  | { frames: { frames: FrameInfo[] } };

/** Everything environment-dependent, injected so the decisions above stay testable. */
export interface InspectDeps {
  /** Hit-test a viewport point. jsdom has none, so tests supply their own. */
  at: (x: number, y: number) => Element | null;
  /** Viewport rect for an element, in CSS px. */
  rectOf: (el: Element) => { x: number; y: number; width: number; height: number };
  /** The computed styles this verb reports (only these — a full dump would bury the signal). */
  stylesOf: (el: Element) => Record<string, string>;
  /** Elements matching a selector. Throws on an invalid selector; the caller turns that into an error. */
  query: (selector: string) => Element[];
  /** The mounted previews (the registry). */
  frames: () => PreviewFrameEntry[];
  /** Ask one preview's engine to describe itself. Resolves `null` when it never answers — which is the
   *  signal that the script is present but not running. */
  probeEngine: (iframe: HTMLIFrameElement) => Promise<EngineProbe | null>;
}

/** The styles that decide whether a click reaches an element (plus the two that explain "I can see it but
 *  can't grab it"). Kept small on purpose: this output is read by a human mid-debug. */
export const REPORTED_STYLES = [
  "pointer-events",
  "z-index",
  "opacity",
  "position",
  "transform",
  "cursor",
  "user-select",
] as const;

/** `tag#id.class1.class2` — enough to find the element in the source without dumping the DOM. */
export function labelOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" && el.className.trim()
    ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
    : "";
  return `${tag}${id}${cls}`;
}

/**
 * Describe one element, including the question that matters: would a click aimed at its centre actually
 * land on it?
 *
 * "Topmost" means the hit-test returns this element **or a descendant** — a descendant still means the
 * click reaches this subtree. An ANCESTOR coming back means it does not (this element is transparent to
 * hit-testing, e.g. `pointer-events: none`), so that counts as covered and the ancestor is named.
 */
export function describeElement(el: Element, deps: InspectDeps): ElementInfo {
  const r = deps.rectOf(el);
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  // A zero-area element can never be hit; hit-testing its "centre" would report whatever is behind it
  // and read as "covered", which misdiagnoses a collapsed rect as an overlay bug.
  const collapsed = r.width < 1 || r.height < 1;
  const top = collapsed ? null : deps.at(cx, cy);
  const topmost = !collapsed && !!top && (top === el || el.contains(top));
  return {
    label: labelOf(el),
    rect: [r.x, r.y, r.width, r.height],
    styles: deps.stylesOf(el),
    topmost_at_centre: topmost,
    ...(topmost ? {} : { covered_by: collapsed ? "(zero-area rect)" : top ? labelOf(top) : "(nothing hit-tests there)" }),
  };
}

/** Run one inspection. Never throws for a "nothing found" case — an empty match is an ANSWER. */
export async function inspectDebug(req: DebugRequest, deps: InspectDeps): Promise<DebugResult> {
  switch (req.op) {
    case "hit": {
      const target = deps.at(req.x, req.y);
      if (!target) return { hit: { chain: [] } };
      const chain: ElementInfo[] = [];
      for (let el: Element | null = target; el; el = el.parentElement) {
        chain.push(describeElement(el, deps));
      }
      return { hit: { chain } };
    }
    case "probe": {
      const found = deps.query(req.selector);
      const picked = req.all ? found : found.slice(0, 1);
      return { probe: { matched: picked.map((el) => describeElement(el, deps)) } };
    }
    case "frames": {
      const entries = deps.frames();
      const frames = await Promise.all(
        entries.map(async (f): Promise<FrameInfo> => {
          const engine = await deps.probeEngine(f.iframe);
          return {
            component: f.component,
            element: describeElement(f.iframe, deps),
            engine_requested: f.engineRequested,
            engine_in_srcdoc: f.engineInSrcdoc,
            ...(engine ? { engine } : {}),
          };
        }),
      );
      return { frames: { frames } };
    }
  }
}
