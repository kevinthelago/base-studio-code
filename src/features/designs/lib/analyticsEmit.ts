// The shipped analytics EMIT runtime (#3816, epic #3809 slice 3) — the fixed, audited code that turns a
// component's #3810 `analytics` manifest (DATA) into a `bsc usage record` (#3812) call when one of its
// actions fires. This is the seam that finally connects the two halves the epic left disconnected: the
// per-node CONTRACT (`ComponentRecord.analytics`) and the per-app SINK (`bsc usage record`).
//
// The load-bearing principle (inherited from #3283): CODE vs DATA. The component DECLARES what it emits;
// THIS runtime — fixed, shipped, never LLM-authored — does the emitting. There is no `track()`/`emit()`
// call in any authored component: emission is derived from the manifest at the render seam, so an app
// composed from instrumented nodes is instrumented BY CONSTRUCTION, uniformly, for free.
//
// It is host-agnostic on purpose: the SINK is injected. A generated app running in a Node/dev process
// spawns `bsc usage record` (the argv `usageRecordArgs` builds); a test collects; a browser logs. Absent
// a sink the whole path is inert — the dev-only / opt-in gate.

import type { AnalyticsEvent } from "./model";

/** What `KitRenderer` reports when a bound handler fires (mirrors its `KitBindings.emit` argument): the
 *  node's component `type`, the action PROP that fired, and the args the underlying handler received. */
export interface ActionFire {
  type: string;
  prop: string;
  args: unknown[];
}

/** A resolved usage event, ready for the sink / the `bsc usage record` CLI. */
export interface UsageRecord {
  event: string;
  props: Record<string, unknown>;
}

/** Where resolved events go. Injected so the runtime is host-agnostic — see the file header. */
export type UsageSink = (rec: UsageRecord) => void;

/** A component-manifest lookup by a node's `type` (the host wires this to the components store; the
 *  shared renderer never reads the store itself). */
export type AnalyticsLookup = (type: string) => AnalyticsEvent[] | undefined;

/**
 * The convention that binds an action PROP to the event a component would declare for it: strip the
 * leading `on`, then PascalCase → snake_case (`onClick` → `click`, `onItemSelected` → `item_selected`,
 * `onFilterChanged` → `filter_changed`). Returns `undefined` for a non-action prop (one that is not
 * `on`-prefixed), which is the same "starts with `on`" shape the `no-analytics` doctor finding uses to
 * decide a component is interactive — so the finding and the runtime agree on what an action is.
 */
export function eventNameForProp(prop: string): string | undefined {
  if (!/^on[A-Z]/.test(prop)) return undefined;
  return prop
    .slice(2) // drop "on"
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2") // acronym boundary: HTMLParser → HTML_Parser
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2") // camel boundary: ItemSelected → Item_Selected
    .toLowerCase();
}

/** A plain data object we can read a payload from — NOT an array and NOT a DOM `Event` (a click's
 *  `MouseEvent` carries no analytics payload, so it must not be mined for prop values). */
function isPlainPayload(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  if (typeof Event !== "undefined" && v instanceof Event) return false;
  return true;
}

/**
 * Resolve a fired action to the usage event its component DECLARED — or `undefined` when the component
 * declared no matching event. It never invents an undeclared event: the manifest is the authority on
 * what an app reports.
 *
 * `props` are filled from the declared `PropSpec` NAMES, best-effort, from `args[0]` when that is a plain
 * data object (e.g. `onChange(nextValue)` where the value is an object, or a synthetic payload the host
 * passes). A DOM event or a scalar arg yields an EMPTY props map — the runtime records the event name
 * (the "what users do" signal `bsc usage summary` ranks) but does not fabricate a payload it cannot see.
 * This is the same honesty the prop validator publishes about what it can and cannot check.
 */
export function resolveAnalyticsEmit(
  manifest: AnalyticsEvent[] | undefined,
  prop: string,
  args: unknown[],
): UsageRecord | undefined {
  if (!manifest || manifest.length === 0) return undefined;
  const name = eventNameForProp(prop);
  if (!name) return undefined;
  const declared = manifest.find((e) => e.event === name);
  if (!declared) return undefined;

  const props: Record<string, unknown> = {};
  const payload = args[0];
  if (declared.props && isPlainPayload(payload)) {
    for (const p of declared.props) {
      if (Object.prototype.hasOwnProperty.call(payload, p.name)) props[p.name] = payload[p.name];
    }
  }
  return { event: declared.event, props };
}

/**
 * Build the exact argv `bsc usage record` (#3812) accepts, so the emit runtime's data-out shape IS the
 * CLI's input — a Node host can `spawn("bsc", usageRecordArgs(rec))` with no glue. `--props` is omitted
 * when the payload is empty (the CLI treats a missing `--props` as no payload).
 */
export function usageRecordArgs(rec: UsageRecord): string[] {
  const argv = ["usage", "record", "--event", rec.event];
  if (Object.keys(rec.props).length > 0) argv.push("--props", JSON.stringify(rec.props));
  return argv;
}

/**
 * Compose a manifest lookup + a sink into the hook `KitRenderer.emit` expects. A fire that resolves to no
 * declared event is a silent no-op — most action props are not instrumented, and that is fine.
 */
export function makeAnalyticsEmit(lookup: AnalyticsLookup, sink: UsageSink): (fire: ActionFire) => void {
  return (fire) => {
    const rec = resolveAnalyticsEmit(lookup(fire.type), fire.prop, fire.args);
    if (rec) sink(rec);
  };
}

/** Build an {@link AnalyticsLookup} from component records keyed by `name` — the studio host's bridge
 *  from its components store to the manifest-driven runtime. */
export function componentAnalyticsLookup(
  records: Iterable<{ name: string; analytics?: AnalyticsEvent[] }>,
): AnalyticsLookup {
  const byName = new Map<string, AnalyticsEvent[] | undefined>();
  for (const r of records) byName.set(r.name, r.analytics);
  return (type) => byName.get(type);
}

/** A sink that COLLECTS records — for tests and for a host that wants to batch/inspect before shipping. */
export function collectingSink(): UsageSink & { records: UsageRecord[] } {
  const records: UsageRecord[] = [];
  const sink = ((rec: UsageRecord) => {
    records.push(rec);
  }) as UsageSink & { records: UsageRecord[] };
  sink.records = records;
  return sink;
}

/** A sink that logs the `bsc usage record` argv — dev visibility. The real DB write is that CLI running
 *  in the app's OWN session, where `$BSC_USAGE_DB` is wired to the per-project `usage.db`. */
export const consoleUsageSink: UsageSink = (rec) => {
  // A deliberate dev-visibility sink; opt-in, never on by default.
  console.info("[usage] bsc", ...usageRecordArgs(rec));
};
