// Org relationships (#2193) — the persona-relationship graph. A PERSONA is a job POSITION; an ORG
// wires positions together with RELATIONSHIPS, each an archetype (Manages / Serves / Oversees /
// Consults / Peers / Stewards) that expands into directed COMMUNICATION FORMS. This makes a fleet's
// interaction topology + coordination prose composable DATA (continuing #2185 / #2027) instead of
// prose hardcoded in fleet/*-protocol.md. Pure model (no React/Tauri) so it's unit-testable and the
// store seeds from it directly. The closed vocabulary (forms + archetypes) is externalized to
// @data/org/*; the built-in orgs to @data/org/orgs/*.json — overlay-editable + in the config bundle.
import formsEmbedded from "@data/org/communication-forms.json";
import archetypesEmbedded from "@data/org/archetypes.json";
import { overlayFile, overlayGlob } from "@/shared/lib/core/configOverrides";

/** The canonical orientation a form typically flows (a HINT; an archetype's lane placement wins). */
export type FormDirection = "down" | "up" | "lateral" | "in" | "out";
/** How the receiver handles the message — the part that isn't "just a command". */
export type FormDelivery =
  | "inject" | "park" | "resume" | "fire-and-forget" | "queue" | "artifact" | "transfer";

/** A communication form — one typed interaction (#2193). The closed core vocabulary; each carries the
 *  runtime properties an edge needs: who blocks, whether it bears authority, and its transport verb. */
export interface CommunicationForm {
  id: string;
  label: string;
  direction: FormDirection;
  delivery: FormDelivery;
  /** Bears authority (a directive/decision/verdict) vs a peer/advisory message. */
  authority: boolean;
  /** Parks the caller until answered (only `escalation`/`review` block today). */
  blocks: boolean;
  /** The `bsc-*` shell verb that carries it at runtime, if one exists yet. */
  transport?: string;
  blurb: string;
}

/** Edge line-style for the canvas, per archetype. */
export type ArchetypeStyle = "solid" | "dashed" | "dotted" | "gated" | "resource";

/** A relationship archetype (#2193) — a named bundle of communication forms per direction. The user
 *  connects two positions with an archetype; it expands into the concrete forms flowing each way. */
export interface RelationshipArchetype {
  id: string;
  label: string;
  style: ArchetypeStyle;
  /** Hue (0–360) for the edge color + legend. */
  hue: number;
  /** Human labels for the two ends (e.g. manager / report). */
  fromLabel: string;
  toLabel: string;
  /** Form ids flowing from → to. */
  forward: string[];
  /** Form ids flowing to → from. */
  backward: string[];
  /** A symmetric relationship (peer/consult) — the canvas draws a double-headed arrow. */
  bidirectional?: boolean;
  blurb: string;
}

/** A position's kind: an agent (a persona), an external actor (a human/system outside the org), or a
 *  resource the org stewards (e.g. the shared commons). */
export type PositionKind = "agent" | "external" | "resource";

/** A node in an org graph — a placed position. `nodeId` is unique WITHIN the org (an org may place the
 *  same persona twice, e.g. Engineer A / Engineer B, so the persona id is not the node identity). */
export interface Position {
  nodeId: string;
  kind: PositionKind;
  /** For `agent` positions: the persona this node embodies (its behavior/role/skills). */
  personaId?: string;
  /** Display override — required for external/resource nodes; optional label for a duplicated persona. */
  label?: string;
  /** Canvas layout (optional; the designer places them). */
  x?: number;
  y?: number;
}

/** A directed relationship edge between two positions (by `nodeId`). A two-way relationship is a
 *  complementary pair of forms within one archetype, not two edges. */
export interface Relationship {
  id: string;
  archetype: string;
  from: string;
  to: string;
  /** Optional curvature (px) for the canvas edge, to fan parallel edges apart. */
  bow?: number;
}

/** An org — a named composition of positions wired by relationships (like a blueprint composes stages).
 *  The unit the `bsc org` store round-trips and the Org designer edits. */
export interface Org {
  id: string;
  name: string;
  blurb?: string;
  positions: Position[];
  relationships: Relationship[];
  /** A packaged org: seeded from code, restored on refresh; clonable + editable but not deletable. */
  builtin?: boolean;
}

/** A packaged org definition (@data/org/orgs/*.json) — an {@link Org} plus a load-time-only `order`. */
interface OrgDef extends Omit<Org, "builtin"> {
  order?: number;
}

// ── The closed vocabulary (externalized, config-dir-overlaid, in the config bundle) ──────────────
/** Every communication form, cheapest-authority first. */
export const COMMUNICATION_FORMS: CommunicationForm[] =
  overlayFile("org/communication-forms.json", formsEmbedded as CommunicationForm[]);

/** Every relationship archetype. */
export const RELATIONSHIP_ARCHETYPES: RelationshipArchetype[] =
  overlayFile("org/archetypes.json", archetypesEmbedded as RelationshipArchetype[]);

const FORM_BY_ID = new Map(COMMUNICATION_FORMS.map((f) => [f.id, f]));
const ARCHETYPE_BY_ID = new Map(RELATIONSHIP_ARCHETYPES.map((a) => [a.id, a]));

/** Look up a communication form by id (undefined if the vocabulary doesn't define it). */
export const formById = (id: string): CommunicationForm | undefined => FORM_BY_ID.get(id);
/** Look up a relationship archetype by id. */
export const archetypeById = (id: string): RelationshipArchetype | undefined => ARCHETYPE_BY_ID.get(id);

// ── Built-in orgs ────────────────────────────────────────────────────────────────────────────────
const orgModules = import.meta.glob<{ default: OrgDef }>("@data/org/orgs/*.json", { eager: true });

/** Assemble the packaged org library from the per-org JSON defs: overlay the config-dir copies, order
 *  them, strip the load-time `order`, and stamp `builtin`. */
export function makeBuiltinOrgs(): Org[] {
  return overlayGlob<OrgDef>("org/orgs", orgModules)
    .map(([, def]) => def)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(({ order: _order, ...o }) => ({
      ...o,
      positions: o.positions ?? [],
      relationships: o.relationships ?? [],
      builtin: true,
    }));
}

/** The packaged orgs (currently the Default fleet), so the designer is populated on day one. */
export const BUILTIN_ORGS: Org[] = makeBuiltinOrgs();

// ── Derivation: the communication summary the UI shows (the generate-from-facets payoff) ─────────
/** One derived communication edge for a position: a form flowing IN or OUT, the other node, and the
 *  archetype it came from. */
export interface CommEdge {
  form: CommunicationForm;
  /** The nodeId on the other end. */
  withNode: string;
  archetype: string;
  dir: "in" | "out";
}

/** Derive a position's full communication surface from the org's relationships — every form flowing in
 *  and out across its edges. This is the auto-generated "who I talk to and how" the panel/prompt read
 *  from, so the topology has one source of truth (the graph), never hand-written per persona. */
export function deriveCommunication(org: Org, nodeId: string): CommEdge[] {
  const out: CommEdge[] = [];
  for (const rel of org.relationships) {
    const arch = archetypeById(rel.archetype);
    if (!arch) continue;
    const push = (formIds: string[], withNode: string, dir: "in" | "out") => {
      for (const fid of formIds) {
        const form = formById(fid);
        if (form) out.push({ form, withNode, archetype: rel.archetype, dir });
      }
    };
    if (rel.from === nodeId) {
      push(arch.forward, rel.to, "out");
      push(arch.backward, rel.to, "in");
    } else if (rel.to === nodeId) {
      push(arch.forward, rel.from, "in");
      push(arch.backward, rel.from, "out");
    }
  }
  return out;
}

// ── Validation ───────────────────────────────────────────────────────────────────────────────────
/** Structural problems in an org: an edge to/from a missing node, or an unknown archetype. Empty means
 *  the graph is well-formed. The designer surfaces these; tests assert built-ins are clean. */
export function orgIssues(org: Org): string[] {
  const issues: string[] = [];
  const nodes = new Set(org.positions.map((p) => p.nodeId));
  for (const r of org.relationships) {
    if (!nodes.has(r.from)) issues.push(`relationship ${r.id}: unknown from-node "${r.from}"`);
    if (!nodes.has(r.to)) issues.push(`relationship ${r.id}: unknown to-node "${r.to}"`);
    if (!archetypeById(r.archetype)) issues.push(`relationship ${r.id}: unknown archetype "${r.archetype}"`);
  }
  return issues;
}

// ── CRUD helpers (mirror personas) ───────────────────────────────────────────────────────────────
/** Slugify an org name into an id fragment. */
export function orgSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "org";
}

/** A blank user org — the "new org" template. */
export function blankOrg(id: string): Org {
  return { id, name: "New org", blurb: "", positions: [], relationships: [] };
}

/** Merge the packaged built-ins with the persisted set: every built-in is present (re-seeded if
 *  dropped), user edits to a built-in are kept, and user-authored orgs are preserved. Keyed by id;
 *  built-in identity is restored so a stale persisted `builtin:false` can't make a packaged org
 *  deletable. Mirrors `reconcilePersonas`. */
export function reconcileOrgs(persisted: Org[]): Org[] {
  const byId = new Map(persisted.map((o) => [o.id, o]));
  const out: Org[] = BUILTIN_ORGS.map((base) => {
    const saved = byId.get(base.id);
    byId.delete(base.id);
    return saved ? { ...base, ...saved, id: base.id, builtin: true } : base;
  });
  for (const o of byId.values()) out.push({ ...o, builtin: false });
  return out;
}
