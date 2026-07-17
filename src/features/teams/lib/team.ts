// Team relationships (#2193) — the persona-relationship graph. A PERSONA is a job POSITION; an ORG
// wires positions together with RELATIONSHIPS, each an archetype (Manages / Serves / Oversees /
// Consults / Peers / Stewards) that expands into directed COMMUNICATION FORMS. This makes a fleet's
// interaction topology + coordination prose composable DATA (continuing #2185 / #2027) instead of
// prose hardcoded in fleet/*-protocol.md. Pure model (no React/Tauri) so it's unit-testable and the
// store seeds from it directly. The closed vocabulary (forms + archetypes) is externalized to
// @data/teams/*; the built-in orgs to @data/teams/orgs/*.json — overlay-editable + in the config bundle.
import formsEmbedded from "@data/teams/communication-forms.json";
import archetypesEmbedded from "@data/teams/archetypes.json";
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
  /** A CYCLICAL relationship (#2578) — the two positions form a deliberate feedback LOOP (auditor ⟳
   *  subject), so it is allowed to close a cycle in the graph and renders as an intentional iteration
   *  loop rather than the red mutual-dependency HAZARD. Only `iterates` carries this today. */
  cyclical?: boolean;
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
 *  The unit the `bsc org` store round-trips and the Team designer edits. */
export interface Team {
  id: string;
  name: string;
  blurb?: string;
  positions: Position[];
  relationships: Relationship[];
  /** A packaged org: seeded from code, restored on refresh; clonable + editable but not deletable. */
  builtin?: boolean;
}

/** A packaged org definition (@data/teams/orgs/*.json) — an {@link Team} plus a load-time-only `order`. */
interface OrgDef extends Omit<Team, "builtin"> {
  order?: number;
}

// ── The closed vocabulary (externalized, config-dir-overlaid, in the config bundle) ──────────────
/** Every communication form, cheapest-authority first. */
export const COMMUNICATION_FORMS: CommunicationForm[] =
  overlayFile("teams/communication-forms.json", formsEmbedded as CommunicationForm[]);

/** Every relationship archetype. */
export const RELATIONSHIP_ARCHETYPES: RelationshipArchetype[] =
  overlayFile("teams/archetypes.json", archetypesEmbedded as RelationshipArchetype[]);

const FORM_BY_ID = new Map(COMMUNICATION_FORMS.map((f) => [f.id, f]));
const ARCHETYPE_BY_ID = new Map(RELATIONSHIP_ARCHETYPES.map((a) => [a.id, a]));

/** Look up a communication form by id (undefined if the vocabulary doesn't define it). */
export const formById = (id: string): CommunicationForm | undefined => FORM_BY_ID.get(id);
/** Look up a relationship archetype by id. */
export const archetypeById = (id: string): RelationshipArchetype | undefined => ARCHETYPE_BY_ID.get(id);

// ── Built-in orgs ────────────────────────────────────────────────────────────────────────────────
const orgModules = import.meta.glob<{ default: OrgDef }>("@data/teams/orgs/*.json", { eager: true });

/** Assemble the packaged org library from the per-org JSON defs: overlay the config-dir copies, order
 *  them, strip the load-time `order`, and stamp `builtin`. */
export function makeBuiltinOrgs(): Team[] {
  return overlayGlob<OrgDef>("teams/orgs", orgModules)
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
export const BUILTIN_ORGS: Team[] = makeBuiltinOrgs();

/** The built-in Studio Network team (#2940) — the id the debug overlay below keys off. */
export const STUDIO_NETWORK_ID = "org-planning-studio";
const DEBUGGER_NODE = "debugger";

/**
 * A RUNTIME overlay on the Studio Network (#3317): when the debug session is toggled on (Settings,
 * `debugSession`, #3298), the **debugger** joins the graph and SERVES the designer — it drains the
 * `bsc request` queue, fixing the `bsc ui` tooling the designer reports. Backed by the `persona-debugger`
 * identity (the app's full-capability `debugger` role, #3322); the live session launches bypass on the
 * shared TerminalHost via `DebugSessionMount` (#3326). Not persisted — the seed stays the always-on
 * network; dragging the overlay
 * no-ops against the stored team. A no-op when off, for a non-studio team, or if already present.
 */
export function augmentStudioNetworkForDebug(org: Team, debugOn: boolean): Team {
  if (!debugOn || org.id !== STUDIO_NETWORK_ID) return org;
  if (org.positions.some((p) => p.nodeId === DEBUGGER_NODE)) return org;
  return {
    ...org,
    positions: [
      ...org.positions,
      { nodeId: DEBUGGER_NODE, kind: "agent", personaId: "persona-debugger", x: 144, y: 48 },
    ],
    relationships: [
      ...org.relationships,
      { id: "r-serves-debugger", archetype: "serves", from: DEBUGGER_NODE, to: "designer", bow: -30 },
    ],
  };
}

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
export function deriveCommunication(org: Team, nodeId: string): CommEdge[] {
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
export function orgIssues(org: Team): string[] {
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

/** A blank user team — the "new team" template (the data entity is still an `Team`; the display noun is
 *  "team", #org→team-rename). */
export function blankOrg(id: string): Team {
  return { id, name: "New team", blurb: "", positions: [], relationships: [] };
}

/** Merge the packaged built-ins with the persisted set: every built-in is present (re-seeded if
 *  dropped), user edits to a built-in are kept, and user-authored orgs are preserved. Keyed by id;
 *  built-in identity is restored so a stale persisted `builtin:false` can't make a packaged org
 *  deletable. Mirrors `reconcilePersonas`. */
export function reconcileOrgs(persisted: Team[]): Team[] {
  const byId = new Map(persisted.map((o) => [o.id, o]));
  const out: Team[] = BUILTIN_ORGS.map((base) => {
    // A built-in team's STRUCTURE is PACKAGED-AUTHORITATIVE (#3330). The app evolves its own built-in teams
    // (the Studio Network grew across #3317/#3322/#2940), but the on-disk store (`~/.base-studio-code/orgs/`)
    // is seeded once and frozen at that version — so a `{ ...base, ...saved }` merge let the stale on-disk
    // copy shadow every later packaged update. We now always take the packaged `base` for a built-in id, so
    // updates to the packaged JSON reach every install. To customize a built-in, CLONE it (→ a user team,
    // carried through untouched below). The on-disk copy is refreshed to match by `hydrateOrgs`.
    byId.delete(base.id);
    return base;
  });
  // On-disk-only USER teams (non-built-in ids) are preserved verbatim — only their `builtin` flag is forced
  // false so a stale/hand-set flag can't masquerade a user team as a built-in.
  for (const o of byId.values()) out.push({ ...o, builtin: false });
  return out;
}

/** A stable content key for a team's authored STRUCTURE (name + blurb + positions + relationships), used to
 *  detect on-disk drift from the packaged built-in (#3330) so `hydrateOrgs` re-pushes only what changed —
 *  never the `builtin` flag or ids, which are structural constants. */
export function orgStructureKey(o: Team): string {
  return JSON.stringify([o.name, o.blurb, o.positions, o.relationships]);
}
