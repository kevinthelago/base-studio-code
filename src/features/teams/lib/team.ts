// Team relationships (#2193) — the persona-relationship graph. A PERSONA is a job POSITION; an ORG
// wires positions together with RELATIONSHIPS, each an archetype (Manages / Serves / Oversees /
// Consults / Peers / Stewards) that expands into directed COMMUNICATION FORMS. This makes a fleet's
// interaction topology + coordination prose composable DATA (continuing #2185 / #2027) instead of
// prose hardcoded in fleet/*-protocol.md. Pure model (no React/Tauri) so it's unit-testable and the
// store seeds from it directly. The closed vocabulary (forms + archetypes) is externalized to
// @data/teams/*; the built-in orgs to @data/teams/orgs/*.json — overlay-editable + in the config bundle.
import { requestNodeId } from "@/shared/lib/session/requestSpawn";
import formsEmbedded from "@data/teams/communication-forms.json";
import archetypesEmbedded from "@data/teams/archetypes.json";
import { overlayFile, overlayGlob } from "@/shared/lib/core/configOverrides";
import { slugify } from "@/shared/lib/core/format";
// The tier vocabulary, TYPE-only so this model stays React/Tauri-free (and the feature-boundary rule
// allows a type import anywhere). The runtime validation of a stored value lives where a value is
// actually read — `teamRoleStreams` at launch, and `bsc teams model` at write time.
import type { ModelId } from "@/app/console/lib/models";

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
  /** For `agent` positions: run THIS placement on a different model tier than the persona's own
   *  default. Unset (the normal state) = the persona's `model`; unset there too = Claude Code's own
   *  default, with no `--model` at all.
   *
   *  It lives on the PLACEMENT rather than the persona because a persona is shared across teams by
   *  design: pointing a team at a cheap tier by editing its personas would move every other team that
   *  places them, and cloning the personas instead forks the start prompt + skill list that were the
   *  reason to share one. This is what makes a team cheap to run while testing.
   *
   *  Precedence at fleet launch, nearest first: the stream's own model > this > the persona's default.
   *  Authored from the CLI with `bsc teams model <team> <node> <tier>`. */
  model?: ModelId;
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

/** The built-in Studio Network team (#2940) — the id the request-session overlay below keys off. */
export const STUDIO_NETWORK_ID = "org-planning-studio";
// The standing `debugger` node is GONE (#debug-nodes-hang-off-the-session-that-filed-them). It was an
// idle stand-in whose job was to show a user that an element existed before it was active; now every
// request draws its own node, labelled with the work and edged to the session that filed it, so the
// idle one showed nothing the live ones do not — while quietly being a second claimant on the same
// queue as the per-request sessions.

/** The Studio Network position that IS the architect — the hub of the drill-in below. */
export const ARCHITECT_NODE = "architect";

/** How each per-technology studio expands, keyed by the SINGULAR Studio Network position it replaces.
 *  The ids are the ones `studioPaneIdForNode` resolves, so each expanded node opens its own session.
 *
 *  EXPANDED HERE rather than in the packaged team JSON, deliberately. The team describes ROLES — one
 *  designer, one librarian, wired to the planner and to the library each stewards — and that is the
 *  right shape for the base-studio-code drill, which answers "what does the app run". The architect's
 *  drill answers "what can I command", and since #system-sessions-are-per-technology those are the
 *  per-technology SESSIONS. Editing the packaged JSON would have forced one of the two views to be
 *  wrong, changed the other drill's layout, and re-seeded a store record for a presentational reason. */
const PER_TECH_EXPANSION: Readonly<Record<string, readonly string[]>> = {
  designer: ["designer-react", "designer-react-native"],
  librarian: ["librarian-rust", "librarian-typescript", "librarian-python"],
};

/** The single-technology sessions the architect commands, passed through unchanged — their stores
 *  carry no tech facet at any level, so there is nothing to split. The debugger and the request-pool
 *  sessions are deliberately absent: neither is reachable from any architect verb. */
const SINGLE_TECH_COMMANDED: readonly string[] = ["sound-designer", "integrator"];

/**
 * The Studio Network as the ARCHITECT commands it (#architect-node-expands-into-system-sessions) —
 * the graph its L0 node expands into.
 *
 * WHY THIS IS A DIFFERENT GRAPH FROM THE WHOLE NETWORK, and not a second entrance to the same one.
 * The base-studio-code project node drills into every app-owned session, which is the honest answer to
 * "what does the app itself run" — it includes the debugger (Settings-toggled, full-capability) and
 * each auto-spawned request session. The ARCHITECT commands neither of those. What it commands is
 * exactly the closed registry its verbs reach (`bsc session start|stop|ask`), so that is what its
 * drill-in shows. Two nodes, two questions, two answers — which is the overlap this item was told not
 * to leave unresolved.
 *
 * The architect itself STAYS in the graph, as the hub the `served-by` edges hang off. Those edges are
 * the L0 relationship work from #glance-reads-left-to-right-sessions-to-libraries moved INSIDE rather
 * than deleted: the direction it settled (the architect points at what serves it) is preserved.
 *
 * A no-op returning the team unchanged for any non-studio team, so a caller cannot accidentally narrow
 * a user's own team to five positions.
 */
export function studioNetworkForArchitect(org: Team): Team {
  if (org.id !== STUDIO_NETWORK_ID) return org;
  const architect = org.positions.find((p) => p.nodeId === ARCHITECT_NODE);
  if (!architect) return org; // a seed without an architect: show what is there rather than nothing

  // Each SINGULAR studio position becomes one node PER TECHNOLOGY, fanned out from the slot it
  // occupied so the expansion inherits the packaged layout instead of inventing one. Everything else
  // the architect commands passes through unchanged.
  const commanded = org.positions.flatMap((p) => {
    const expand = PER_TECH_EXPANSION[p.nodeId];
    if (expand) {
      return expand.map((nodeId, i) => ({
        ...p,
        nodeId,
        x: (p.x ?? 0) + (i - (expand.length - 1) / 2) * 132,
        y: p.y,
      }));
    }
    return SINGLE_TECH_COMMANDED.includes(p.nodeId) ? [p] : [];
  });
  return {
    ...org,
    positions: [architect, ...commanded],
    // Only the architect->session edges. The network's own relationships (designer<->librarian, the
    // planner's sourcing) describe collaboration BETWEEN sessions, which is the base-studio-code
    // node's story, not this one — and half of them would dangle here anyway, since the planner and
    // the libraries are not in this position set.
    relationships: commanded.map((p) => ({
      id: `r-commands-${p.nodeId}`,
      archetype: "stewards",
      from: ARCHITECT_NODE,
      to: p.nodeId,
      bow: 0,
    })),
  };
}

/** One live request session, as the graph needs it (#debug-nodes-hang-off-the-session-that-filed-them). */
export interface RequestNodeSpec {
  id: number;
  /** The pane id of the session that FILED it (`designer-studio:react`). Absent for a request filed
   *  outside a session. */
  origin?: string | null;
  /** The label form — always populated by the request store. */
  title?: string | null;
}

/**
 * Resolve a filing session's PANE id to the graph position it should hang off
 * (#debug-nodes-hang-off-the-session-that-filed-them).
 *
 * INJECTED, not implemented here. The mapping is owned by whoever owns the node↔session table
 * (`studioProject`'s `STUDIO_NODE_SESSION`), and `teams` is feature-agnostic — it cannot import a glance
 * module. Passing the resolver in keeps the augmentation pure and lets the caller supply the ONE
 * authoritative mapping rather than a second copy of it.
 *
 * That indirection is not ceremony: the first version of this parsed the pane id as
 * `<role>-studio:<tech>` and every studio origin resolved to null, because the real ids are
 * `design-studio:designer-react` and `algorithms-studio:librarian-typescript` — the studio is named for
 * the SURFACE, not the role, and the role is in the tail. A guessed string shape passes every gate when
 * the tests are written from the same guess; inverting the real table cannot.
 *
 * `present` is the set of node ids actually on this graph, so a resolver can prefer the per-technology
 * node where one is drawn and fall back to the role node where it is not — the two studio drills render
 * different id sets. Returning null means "not for this graph", and the caller leaves the request out
 * rather than attaching it to a default.
 */
export type OriginHostResolver = (origin: string | null | undefined, present: ReadonlySet<string>) => string | null;

/**
 * Add a node per LIVE request session (#3498, re-pointed by
 * #debug-nodes-hang-off-the-session-that-filed-them), so each one is visible and openable in the Glance
 * graph instead of a hidden background actor. An auto-spawned session the user cannot see is one they
 * cannot supervise or stop, which is the whole reason this exists.
 *
 * Each node is LABELLED with the request (`debug - <title>`) and edged `serves →` **the session that
 * filed it**, so the graph reads as "requests 85, 86 from the designer; 102, 519 from the librarian".
 * Both were wrong before: the label was the bare node id, and the edge was hardwired to `designer` for
 * every request, so a librarian's request drew to the designer.
 *
 * A request whose origin RESOLVES TO NO POSITION on this graph is SKIPPED rather than attached to a
 * default. That covers the director-filed request (`myproject:director`), which belongs in its project's
 * drill; an unparented node reads as a bug, and a wrongly-parented one is worse — it asserts a
 * relationship that does not exist.
 *
 * A request with NO ORIGIN AT ALL is the opposite case and is DRAWN, unparented. It belongs to no graph
 * by construction — nothing claims it, so no other drill can pick it up — and skipping it left a live
 * session with a node in no graph anywhere: unwatchable, unopenable and unstoppable, which is the one
 * state every request node exists to prevent. (Requests filed before `bsc request new` started stamping
 * `$BSC_AUDIT_PANE` are exactly this shape, and one of them was running `claude` invisibly when this was
 * found.) It gets no edge, because there is genuinely no relationship to assert — the honest rendering
 * of "something is running and nobody said who asked for it".
 *
 * Idempotent, and a no-op off the Studio Network or with no live sessions.
 */
export function augmentStudioNetworkForRequests(
  org: Team,
  requests: readonly RequestNodeSpec[],
  hostForOrigin: OriginHostResolver,
): Team {
  if (!requests.length || org.id !== STUDIO_NETWORK_ID) return org;
  const present = new Set(org.positions.map((p) => p.nodeId));
  const add = requests
    .map((r) => ({ ...r, host: hostForOrigin(r.origin, present) }))
    // `host === null` splits two unlike cases, and only one of them is a skip: an origin that named a
    // session this graph does not draw belongs to another drill, while an ABSENT origin belongs to none.
    // Keeping the second is what stops a live session from having no node anywhere.
    .filter((r) => (r.host !== null || !hasOrigin(r)) && !present.has(requestNodeId(r.id)));
  if (!add.length) return org;
  // Fan each host's requests in a row BENEATH that host, so the layout says the same thing the edges do.
  // Grouped per host (not one global row) — with two designers and a librarian all filing, one row would
  // interleave them and the clustering the edges express would be invisible. The unparented ones share
  // one pseudo-host row of their own, laid out below the graph rather than beside anybody.
  const perHost = new Map<string, number>();
  const positions: Position[] = add.map((r) => {
    const key = r.host ?? UNPARENTED_ROW;
    const host = r.host === null ? undefined : org.positions.find((p) => p.nodeId === r.host);
    const n = perHost.get(key) ?? 0;
    perHost.set(key, n + 1);
    // An unparented node sits under the LOWEST drawn position, so it reads as "extra, below everything"
    // rather than colliding with whichever position happens to sit at the default coordinates.
    const baseX = host?.x ?? 96;
    const baseY = host?.y ?? maxY(org) + 48;
    return {
      nodeId: requestNodeId(r.id),
      kind: "agent" as const,
      personaId: "persona-debugger",
      label: requestNodeLabel(r.title),
      x: baseX + (n - 0.5) * 96,
      y: baseY + 96,
    };
  });
  return {
    ...org,
    positions: [...org.positions, ...positions],
    relationships: [
      ...org.relationships,
      // ONLY the hosted ones get an edge. An unparented request has nobody to point at, and inventing a
      // target here is the exact failure the resolver was written to end.
      ...add.filter((r) => r.host !== null).map((r) => ({
        id: `r-serves-${requestNodeId(r.id)}`,
        archetype: "serves",
        from: requestNodeId(r.id),
        to: r.host!,
        bow: -18,
      })),
    ],
  };
}

/** The layout bucket the origin-less request nodes share. Parenthesised so it can never collide with a
 *  real host key in the per-host fan-out counter — a position's nodeId is a slug. */
const UNPARENTED_ROW = "(unparented)";

/** Whether a request names a filing session at all. Blank-or-missing is "nobody said", which is the case
 *  {@link augmentStudioNetworkForRequests} draws unparented; anything else is a claim this graph either
 *  can host or must leave to another one. */
function hasOrigin(r: RequestNodeSpec): boolean {
  return !!(r.origin ?? "").trim();
}

/** The bottom of the drawn graph, so an unparented node lands below it rather than on top of a position. */
function maxY(org: Team): number {
  return org.positions.reduce((m, p) => Math.max(m, p.y ?? 0), 0);
}

/** The label a request session's node carries — `debug - <title>`.
 *
 *  The prefix says WHAT the node is (a debug session) and the title says what it is working, which is the
 *  pair a user needs to read a graph holding several at once. A request store always populates a title,
 *  but the fallback keeps a node named rather than blank if one ever arrives empty. */
export function requestNodeLabel(title: string | null | undefined): string {
  const t = (title ?? "").trim();
  return t ? `debug - ${t}` : "debug";
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
  return slugify(name) || "org";
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
