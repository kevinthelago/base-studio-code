// Kit-change propagation (#2277) — the pure decision spine. A kit is a shared dependency; changing a
// component is a *release*, and every app built on the kit is a consumer that may need to adopt it. This
// module owns the model + the fan-out logic ONLY (no storage, no delivery): classify a change, and turn
// { change × consumers } into a per-consumer dispatch plan. The consumer index (who uses the kit), the
// change origin (`bsc component set` emitting a change), and the delivery (issuer / `bsc-assign` /
// GitHub issue) are follow-up slices that ride on this.
import type { ComponentRecord } from "./model";

/** How much a change forces on consumers — drives whether it's a mandatory adopt or a heads-up. */
export type ChangeClass = "additive" | "breaking" | "fix";

/** One released change to a kit component — the signal fanned out to consumers. */
export interface KitChange {
  /** Deterministic fingerprint (the dedup key). */
  id: string;
  kitId: string;
  /** The changed component's name. */
  component: string;
  from?: string;
  to?: string;
  class: ChangeClass;
  summary: string;
  /** Migration note for a breaking change (shown in the issue/dispatch). */
  migration?: string;
}

/** A project that consumes a kit — one edge of the consumer index (the `kit_usage` graph, a later slice). */
export interface KitConsumer {
  projectKey: string;
  kitId: string;
  /** The project's fleet is live / in maintenance posture (→ can dispatch straight to a stream). */
  live?: boolean;
  /** Per-consumer opt-in to auto-dispatch. Absent/false ⇒ notify-only (the safe default). */
  auto?: boolean;
}

/** How a change reaches one consumer: a heads-up, an opened issue, or a live-stream assignment. */
export type DispatchKind = "notify" | "issue" | "assign";

/** The planned action for one consumer of a change. */
export interface Dispatch {
  projectKey: string;
  kind: DispatchKind;
  change: KitChange;
  /** Why this kind was chosen (for the audit/log surface). */
  reason: string;
}

/** A deterministic change fingerprint — the dedup key, shared shape with any future producer. */
export function changeId(kitId: string, component: string, to: string | undefined, cls: ChangeClass): string {
  return `${kitId}:${component}:${to ?? ""}:${cls}`;
}

/** A consumer-index edge id — one edge per (project, kit). Byte-identical to the Rust `usage_id`
 *  (`crates/bsc-component/src/usage.rs`) so the frontend and `bsc component usage` agree. */
export function kitUsageId(projectKey: string, kitId: string): string {
  return `${projectKey}>${kitId}`;
}

/** Classify a before→after component diff (author-declared class overrides this, see {@link makeChange}).
 *  Breaking wins: a prop removed, a prop that became required, or a prop whose type changed, or a variant
 *  removed. Additive: a new prop or variant. Otherwise a fix. */
export function classifyChange(before: ComponentRecord, after: ComponentRecord): ChangeClass {
  const afterProps = new Map(after.props.map((p) => [p.name, p]));
  for (const bp of before.props) {
    const ap = afterProps.get(bp.name);
    if (!ap) return "breaking"; // removed
    if (!bp.req && ap.req) return "breaking"; // became required
    if (bp.type !== ap.type) return "breaking"; // type changed
  }
  if (before.variants.some((v) => !after.variants.includes(v))) return "breaking"; // variant removed
  const beforeProps = new Set(before.props.map((p) => p.name));
  if (after.props.some((p) => !beforeProps.has(p.name))) return "additive"; // new prop
  if (after.variants.some((v) => !before.variants.includes(v))) return "additive"; // new variant
  return "fix";
}

function defaultSummary(after: ComponentRecord, before: ComponentRecord | undefined, cls: ChangeClass): string {
  const ver = before?.version && after.version ? ` (${before.version} → ${after.version})` : after.version ? ` (${after.version})` : "";
  const verb = cls === "breaking" ? "changed breaking" : cls === "additive" ? "extended" : "fixed";
  return `${after.name}${ver} ${verb}`;
}

/** Build a {@link KitChange} from an after-component (and an optional before, to classify + diff). An
 *  explicit `override.class`/`summary`/`migration` wins over the derived ones (author-declared change). */
export function makeChange(
  after: ComponentRecord,
  before?: ComponentRecord,
  override?: Partial<Pick<KitChange, "class" | "summary" | "migration">>,
): KitChange {
  const cls = override?.class ?? (before ? classifyChange(before, after) : "additive");
  return {
    id: changeId(after.kitId, after.name, after.version, cls),
    kitId: after.kitId,
    component: after.name,
    from: before?.version,
    to: after.version,
    class: cls,
    summary: override?.summary ?? defaultSummary(after, before, cls),
    migration: override?.migration,
  };
}

/** Fan a change out over the consumer index: one {@link Dispatch} per consumer OF THE CHANGED KIT.
 *  Gated notify-only by default — a consumer only gets an issue/assignment when it opted into `auto`
 *  AND the change is `breaking`; a live fleet is assigned a stream, a dormant one gets a `kit-update`
 *  issue. Additive/fix changes (and every non-opted-in consumer) are notify-only, so a wide blast never
 *  silently opens N issues. */
export function planPropagation(change: KitChange, consumers: KitConsumer[]): Dispatch[] {
  return consumers
    .filter((c) => c.kitId === change.kitId)
    .map((c) => {
      const dispatch = !!c.auto && change.class === "breaking";
      const kind: DispatchKind = !dispatch ? "notify" : c.live ? "assign" : "issue";
      const reason = !dispatch
        ? "notify-only (default / non-breaking / not opted-in)"
        : c.live
          ? "breaking + auto + live fleet → assign the UI stream"
          : "breaking + auto, no live fleet → open a kit-update issue";
      return { projectKey: c.projectKey, kind, change, reason };
    });
}

/** Drop dispatches already delivered — dedup by (projectKey, change.id), so a re-run of the same change
 *  never re-issues/re-assigns. `seen` holds the delivered keys; the returned array is the fresh work. */
export function dispatchKey(d: Dispatch): string {
  return `${d.projectKey}:${d.change.id}`;
}
export function dedupeDispatches(dispatches: Dispatch[], seen: Set<string>): Dispatch[] {
  return dispatches.filter((d) => !seen.has(dispatchKey(d)));
}
