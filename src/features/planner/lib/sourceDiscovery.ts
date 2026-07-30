// Discovery-declared integrations → the Source pane's proposals (#4054).
//
// The pane's "Confirm N sources" banner used to be seeded by scanning the PITCH for keywords
// (`proposeFromPitch`). That was the best signal available when it was written, and it no longer is:
// since #4024 the planner records the integrations the user actually CONFIRMED in conversation, each
// with a `direction`, and `direction: "source"` means exactly "data migrates FROM this" — which is what
// the Source pane exists to offer.
//
// Guessing from keywords when the answer has been stated is the wrong input: the scan can omit a system
// the user named and propose one they never mentioned. These helpers are pure so the precedence and the
// direction filter are unit-testable without the pane.

/** One declared integration as `bsc plan discovery integration list --json` emits it (camelCase wire,
 *  matching the Rust `PlanIntegration`). Every field but `id` may be absent. */
export interface DeclaredIntegration {
  id: string;
  name?: string;
  /** `source` = data migrates FROM it | `runtime` = the built app talks to it while running. */
  direction?: string;
  docs?: string;
  baseUrl?: string;
  /** The auth SCHEME in prose ("OAuth2 client credentials"). Never a secret. */
  auth?: string;
  purpose?: string;
}

/** The `direction` the Source pane cares about — a migration source, not a runtime dependency. */
export const SOURCE_DIRECTION = "source";

/**
 * The migration sources among `rows`, in declaration order.
 *
 * Filters defensively rather than trusting the caller's `--direction` flag: a runtime integration must
 * NEVER reach the Source pane. That is the entire point of the split — a payment API is not something
 * you migrate off, and offering it as one sends the user down a pointless connect-and-scan path.
 * Rows without a usable `id` are dropped (they cannot be keyed), and duplicate ids collapse to the
 * first, so a re-declared integration proposes once.
 */
export function migrationSources(rows: readonly DeclaredIntegration[]): DeclaredIntegration[] {
  const seen = new Set<string>();
  const out: DeclaredIntegration[] = [];
  for (const r of rows ?? []) {
    const id = (r?.id ?? "").trim();
    if (!id || r?.direction !== SOURCE_DIRECTION || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...r, id });
  }
  return out;
}

/**
 * The connector ids to seed the pre-declare banner with, and where they came from.
 *
 * **Discovery wins.** The pitch scan survives only as the fallback for a project whose Discovery
 * predates #4024 (or that never worked the `integrations` topic) — so a proposal is traceable to a
 * decision whenever one exists, and the older behaviour is preserved exactly where it isn't. Pure.
 */
export function proposedSourceIds(
  declared: readonly DeclaredIntegration[],
  fromPitch: readonly string[],
): { ids: string[]; origin: "discovery" | "pitch" | "none" } {
  const sources = migrationSources(declared);
  if (sources.length > 0) return { ids: sources.map((s) => s.id), origin: "discovery" };
  const pitch = (fromPitch ?? []).filter(Boolean);
  return pitch.length > 0 ? { ids: [...pitch], origin: "pitch" } : { ids: [], origin: "none" };
}

/**
 * The non-secret connect fields Discovery already captured for `id`, ready to seed a newly declared
 * source — so an agent authoring its connector starts from the vendor reference the user gave instead
 * of a blank form.
 *
 * ONLY `baseUrl` and `docs` cross: both are plain URLs. `auth` is deliberately excluded even though it
 * is a prose scheme rather than a credential — `DeclaredSource.fields` is the connect-form's value bag,
 * and a scheme string is not a field value. Nothing secret exists on this path to begin with.
 */
export function connectFieldsFor(
  id: string,
  declared: readonly DeclaredIntegration[],
): Record<string, string> {
  const row = migrationSources(declared).find((r) => r.id === id);
  if (!row) return {};
  const fields: Record<string, string> = {};
  const baseUrl = (row.baseUrl ?? "").trim();
  const docs = (row.docs ?? "").trim();
  if (baseUrl) fields.baseUrl = baseUrl;
  if (docs) fields.docs = docs;
  return fields;
}
