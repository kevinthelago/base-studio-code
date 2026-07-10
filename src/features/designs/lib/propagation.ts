// Kit-change propagation (#2277) — the pure decision spine. A kit is a shared dependency; changing a
// component is a *release*, and every app built on the kit is a consumer that may need to adopt it. This
// module owns the model + the fan-out logic ONLY (no storage, no delivery): classify a change, and turn
// { change × consumers } into a per-consumer dispatch plan. The consumer index (who uses the kit), the
// change origin (`bsc ui set` emitting a change), and the delivery (`bsc-assign` into the consumer's
// live director → the UI worker re-runs `bsc ui emit sync`, #2806) are follow-up slices that ride on
// this. The GitHub-issue rail was dropped (#2806): a dormant consumer holds until its fleet is live.
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

/** How a change reaches one consumer: a surfaced heads-up, or a live-fleet stream assignment (#2806 —
 *  the GitHub-issue rail was dropped; adoption is the UI worker re-running `bsc ui emit sync`). */
export type DispatchKind = "notify" | "assign";

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
 *  (`crates/bsc-component/src/usage.rs`) so the frontend and `bsc ui usage` agree. */
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
 *  Gated notify-only by default — a consumer only gets an `assign` when it opted into `auto` AND the
 *  change is `breaking`. Liveness does NOT change the KIND (it gates DELIVERY in {@link planKitDrain}):
 *  a breaking+auto consumer is `assign` whether or not its fleet is live now. Additive/fix (and every
 *  non-opted-in consumer) are notify-only, so a wide blast never auto-dispatches N sessions. */
export function planPropagation(change: KitChange, consumers: KitConsumer[]): Dispatch[] {
  return consumers
    .filter((c) => c.kitId === change.kitId)
    .map((c) => {
      const dispatch = !!c.auto && change.class === "breaking";
      const kind: DispatchKind = dispatch ? "assign" : "notify";
      const reason = dispatch
        ? "breaking + auto → assign the UI stream to re-run `bsc ui emit sync`"
        : "notify-only (default / non-breaking / not opted-in)";
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

// ── Delivery (#2277) — draining the planned dispatches to the rails ────────────
// planPropagation decides the intent; this decides what to actually FIRE this cycle. Kept pure (no
// store/Tauri) so the three delivery guarantees are unit-tested in isolation, exactly like faultTriage:
//   • GATE       — the per-project auto-dispatch toggle. OFF (default) ⇒ deliver nothing (surface-only).
//   • DEDUP      — a (consumer, change) delivered once never re-fires while it stays queued.
//   • RATE-LIMIT — a wide blast (one change × N consumers, or a burst of changes) is capped per cycle.

/** How an actionable change reaches a consumer at delivery time (#2806): assigned into its LIVE fleet's
 *  director (bsc-issue → bsc-assign → the UI worker re-runs `bsc ui emit sync`). The only rail — a
 *  consumer with no live fleet HOLDS (see {@link planKitDrain}) rather than opening a GitHub issue. */
export type KitRail = "assign";

/** One change to actually deliver to one consumer this cycle. */
export interface KitDelivery {
  projectKey: string;
  change: KitChange;
  rail: KitRail;
}

/** Per-consumer drain policy, evaluated at delivery time — so `live` reflects the fleet's CURRENT state,
 *  not whatever it was when the change was queued (the kind baked by planPropagation can go stale). */
export interface KitDrainConfig {
  /** The per-project auto-dispatch toggle. `false` (default) ⇒ surface-only: nothing is delivered. */
  enabled: boolean;
  /** The consumer's fleet is live now ⇒ assign to its director; else open a kit-update issue. */
  live: boolean;
  /** Storm guard: at most this many deliveries fired for the consumer in one cycle. */
  maxPerCycle: number;
}

export interface KitDrainPlan {
  /** Changes to deliver THIS cycle. */
  deliver: KitDelivery[];
  /** The (consumer, change) keys now delivered — carry back as `delivered` next cycle so nothing re-fires. */
  nextDelivered: string[];
}

/** Conservative default: ≤3 deliveries per consumer per cycle (a slow poll spreads a wide blast). */
export const DEFAULT_KIT_DRAIN: Omit<KitDrainConfig, "enabled" | "live"> = { maxPerCycle: 3 };

/** The delivered-ledger key for a (consumer, change) — same shape as {@link dispatchKey}. */
export function deliveryKey(projectKey: string, changeId: string): string {
  return `${projectKey}:${changeId}`;
}

/**
 * Decide which of a consumer's queued dispatches to DELIVER this cycle. Pure + deterministic.
 * Only BREAKING changes auto-fire (a mandatory adopt); additive/fix stay surface-only (notify).
 *
 * @param dispatches  the consumer's queued {@link Dispatch}es (the fan-out records for one project).
 * @param delivered   (consumer, change) keys already fired (the dedup ledger; carry `nextDelivered`).
 * @param cfg         the per-consumer policy (gate + liveness + rate cap).
 *
 * Guarantees:
 *  - GATE: `cfg.enabled === false` ⇒ `deliver` is empty.
 *  - DEDUP: a (consumer, change) already in `delivered` is never re-fired.
 *  - RATE-LIMIT: `deliver.length ≤ maxPerCycle`.
 * The only rail is `assign`; a non-live consumer HOLDS (delivers nothing) — no GitHub-issue fallback (#2806).
 */
export function planKitDrain(dispatches: Dispatch[], delivered: Iterable<string>, cfg: KitDrainConfig): KitDrainPlan {
  const already = new Set(delivered);
  // GATE + assign-only HOLD (#2806): deliver only when enabled AND the fleet is LIVE. A dormant consumer
  // holds its queue (nothing marked delivered → carried forward), adopting on its next launch — never
  // via a GitHub issue.
  if (!cfg.enabled || !cfg.live) return { deliver: [], nextDelivered: [...already] };
  const chosen = dispatches
    .filter((d) => d.change.class === "breaking" && !already.has(deliveryKey(d.projectKey, d.change.id)))
    // Deterministic order so a capped cycle picks a stable subset.
    .sort((a, b) => deliveryKey(a.projectKey, a.change.id).localeCompare(deliveryKey(b.projectKey, b.change.id)))
    .slice(0, Math.max(0, cfg.maxPerCycle))
    .map((d): KitDelivery => ({ projectKey: d.projectKey, change: d.change, rail: "assign" }));
  return { deliver: chosen, nextDelivered: [...already, ...chosen.map((c) => deliveryKey(c.projectKey, c.change.id))] };
}

/** The director-facing message routing a kit change into a live fleet (the `assign` rail). The director
 *  captures + assigns adoption via the coordination emitters, exactly like the fault-triage prompt. */
export function kitDispatchPrompt(change: KitChange): string {
  const ver = change.from && change.to ? ` (${change.from} → ${change.to})` : "";
  const mig = change.migration ? `\nMigration: ${change.migration}` : "";
  const breaking = change.class === "breaking";
  return [
    `[kit-update] The \`${change.kitId}\` kit released a ${change.class} change to \`${change.component}\`${ver}` +
      " — adopt it in this app:",
    change.summary + mig,
    "`bsc-assign` the UI worker (the stream whose `owns` lane covers the vendored kit dir) to re-run:",
    "  bsc ui emit sync <kit-dir>",
    breaking
      ? "That re-emits the managed vendored files from the updated kit; then reconcile any now-broken " +
        "call sites — the migration note + the type/eslint errors point at them."
      : "That re-emits the managed vendored files (no hand-edits; a diverged file is skipped, not clobbered).",
    "Capture it with `bsc-issue` first, then `bsc-assign <session>`.",
  ].join("\n");
}
