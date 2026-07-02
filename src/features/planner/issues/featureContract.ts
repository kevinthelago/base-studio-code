// Pure helpers for the per-issue FeatureContract (#200) — the context-local unit
// of planned work. An agent should be able to execute a FeatureContract reading
// ONLY the contract + its linked dependency contracts, never a sibling's impl.
//
// The two load-bearing fields are `consumes` (the frozen interfaces it calls) and
// `produces` (the frozen surface it must expose) — the seams between components.
// Everything else supports them. The canonical human template lives in
// docs/planning/issue-contract-template.md; `renderFeatureContract` emits the same
// shape as a GitHub issue body.
//
// Free of React / xterm / Tauri imports so the logic is unit-testable in isolation
// and shared between the planner UI and its tests (matches planStages.ts /
// ghStructure.ts).

/**
 * One interface at a seam — what a feature exposes (`produces`) or relies on
 * (`consumes`). The agent depends only on `signature`; it never reads the
 * implementation behind it.
 */
export interface ContractRef {
  /** Symbol/endpoint/event name — the key consumers match against. */
  name: string;
  /** Where the canonical definition lives (e.g. `src/lib/tunnel.ts:TunnelState`). */
  definedIn: string;
  /** The exact frozen signature / type / shape. */
  signature: string;
  /** Produces-only: what can fail and what must hold. */
  invariants?: string;
}

/** How a feature is proven done. */
export interface VerificationRef {
  /** Failing tests to make pass, or tests to add. */
  tests: string[];
  /** The exact gate command(s) that must be green. */
  gate: string[];
}

/**
 * One context-local unit of planned work. Rendered into a GitHub issue body and
 * validated by the critic (see {@link validateContracts}).
 */
export interface FeatureContract {
  /** Stable kebab id — also the branch/stream slug. */
  id: string;
  /** Imperative title, scoped to one region. */
  title: string;
  /** Stream/area this belongs to. */
  stream?: string;
  /** Phase index or name. */
  phase?: string;
  /** 1–3 sentences; what it delivers and why. No implementation detail. */
  goal: string;
  /** Testable "done when" criteria. */
  acceptance: string[];
  /** Dirs/globs this feature owns — the file-level boundary. */
  owns: string[];
  /** Inbound frozen contracts it calls. The agent relies on these, never their impl. */
  consumes: ContractRef[];
  /** Outbound frozen surface it must expose. Dependents rely on this exactly. */
  produces: ContractRef[];
  /** Tables, schemas, message/event shapes touched. */
  data?: string[];
  /** Specific files + stub fns from the kickoff scaffold this fills in. */
  skeleton?: string[];
  /** How it's verified. */
  verification: VerificationRef;
  /** Issue refs that must land first (usually the contract owners). */
  dependsOn: string[];
  /** Issue refs this one blocks. */
  blocks?: string[];
  /** Explicit exclusions to stop scope bleed. */
  nonGoals?: string[];
  /** Links to plan sections + the contracts source of truth. */
  references?: string[];
  /** Autonomy guidance / freeform notes. */
  notes?: string;
}

// ── Rendering ──────────────────────────────────────────────────────────────────

/** Escape a value for a single Markdown table cell (pipes would break the row).
 *  Escape the backslash FIRST so the escaping is complete (js/incomplete-sanitization, #1011):
 *  otherwise an input like `\|` would become `\\|` — a literal backslash + an UNescaped pipe
 *  that still breaks the row. Then escape pipes and flatten newlines. */
function cell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function checklist(items: string[]): string {
  return items.map((i) => `- [ ] ${i.trim()}`).join("\n");
}

function bullets(items: string[]): string {
  return items.map((i) => `- ${i.trim()}`).join("\n");
}

/**
 * Render a {@link FeatureContract} into a GitHub issue-body Markdown string,
 * matching docs/planning/issue-contract-template.md. Optional sections are omitted
 * when empty so a small contract renders compactly.
 */
export function renderFeatureContract(fc: FeatureContract): string {
  const out: string[] = [];

  // Heading: title · stream · phase
  const meta: string[] = [];
  if (fc.stream) meta.push(`stream: ${fc.stream}`);
  if (fc.phase) meta.push(`phase: ${fc.phase}`);
  out.push(`# ${fc.title}${meta.length ? `  ·  ${meta.join("  ·  ")}` : ""}`);

  out.push(`## Goal\n${fc.goal.trim()}`);

  out.push(`## Acceptance criteria\n${checklist(fc.acceptance)}`);

  out.push(
    `## Ownership boundary\nOwns (may modify):\n${bullets(fc.owns)}\n\n` +
      `Do NOT modify outside these — another stream owns them; coordinate via contracts, not edits.`,
  );

  if (fc.consumes.length) {
    const rows = fc.consumes
      .map((c) => `| \`${cell(c.name)}\` | ${cell(c.definedIn)} | \`${cell(c.signature)}\` |`)
      .join("\n");
    out.push(
      `## Consumes (inbound — frozen; do not read their impl)\n` +
        `| Name | Defined in | Signature / shape |\n|------|-----------|-------------------|\n${rows}\n\n` +
        `> Depend only on these signatures. If one is missing or wrong, that's a blocker — raise it, don't reach into the source.`,
    );
  }

  if (fc.produces.length) {
    const rows = fc.produces
      .map(
        (p) =>
          `| \`${cell(p.name)}\` | \`${cell(p.signature)}\` | ${cell(p.invariants ?? "")} |`,
      )
      .join("\n");
    out.push(
      `## Produces (outbound — frozen for dependents)\n` +
        `| Name | Signature / shape | Errors / invariants |\n|------|-------------------|---------------------|\n${rows}\n\n` +
        `> Dependents rely on this exactly. Changing it later = a coordinated change across its consumers.`,
    );
  }

  if (fc.data?.length) out.push(`## Data / schema / events touched\n${bullets(fc.data)}`);
  if (fc.skeleton?.length) out.push(`## Skeleton / stubs to implement\n${bullets(fc.skeleton)}`);

  out.push(
    `## Verification\n` +
      `- Tests: ${fc.verification.tests.length ? fc.verification.tests.join("; ") : "—"}\n` +
      `- Gate: ${fc.verification.gate.map((g) => `\`${g}\``).join(" · ") || "—"}`,
  );

  const deps: string[] = [];
  if (fc.dependsOn.length) deps.push(`- depends_on: ${fc.dependsOn.join(", ")}`);
  if (fc.blocks?.length) deps.push(`- blocks: ${fc.blocks.join(", ")}`);
  if (deps.length) out.push(`## Dependencies\n${deps.join("\n")}`);

  if (fc.nonGoals?.length) out.push(`## Non-goals\n${bullets(fc.nonGoals)}`);
  if (fc.references?.length) out.push(`## References\n${bullets(fc.references)}`);
  if (fc.notes?.trim()) out.push(`## Notes\n${fc.notes.trim()}`);

  return out.join("\n\n") + "\n";
}

// ── Validation (the critic's no-dangling-contracts check) ───────────────────────

/** A `consumes` entry that no feature in the set `produces`. */
export interface DanglingConsume {
  /** Id of the feature that consumes it. */
  featureId: string;
  ref: ContractRef;
}

/** A contract name produced by more than one feature (an ownership conflict). */
export interface DuplicateProduce {
  name: string;
  producedBy: string[];
}

/** A `dependsOn` ref that doesn't match any feature id/issue ref in the set. */
export interface UnknownDependency {
  featureId: string;
  dependsOn: string;
}

export interface ContractValidation {
  ok: boolean;
  /** Consumed contracts nothing produces — the agent would have no source for them. */
  dangling: DanglingConsume[];
  /** Same contract produced by two+ features — the seam has no single owner. */
  duplicateProduces: DuplicateProduce[];
  /** dependsOn refs that resolve to no feature in the set. */
  unknownDependencies: UnknownDependency[];
}

/**
 * Validate a set of {@link FeatureContract}s for context-locality:
 *
 * - **dangling** — every `consumes.name` must be produced by some feature in the
 *   set; otherwise an agent has no frozen source to build against.
 * - **duplicateProduces** — each produced contract name must have exactly one
 *   owner, so a seam can't drift from two sides.
 * - **unknownDependencies** — each `dependsOn` should resolve to a feature `id`
 *   (or its issue ref via `idByRef`); a ref to nothing is a planning hole.
 *
 * Pure and side-effect free. `idByRef` optionally maps issue refs (e.g. `#12`) to
 * feature ids so `dependsOn: ["#12"]` resolves; unmapped refs fall back to id match.
 */
export function validateContracts(
  contracts: FeatureContract[],
  idByRef: Record<string, string> = {},
): ContractValidation {
  const produced = new Map<string, string[]>();
  for (const c of contracts) {
    for (const p of c.produces) {
      const owners = produced.get(p.name) ?? [];
      owners.push(c.id);
      produced.set(p.name, owners);
    }
  }

  const dangling: DanglingConsume[] = [];
  for (const c of contracts) {
    for (const ref of c.consumes) {
      if (!produced.has(ref.name)) dangling.push({ featureId: c.id, ref });
    }
  }

  const duplicateProduces: DuplicateProduce[] = [];
  for (const [name, producedBy] of produced) {
    if (producedBy.length > 1) duplicateProduces.push({ name, producedBy });
  }

  const ids = new Set(contracts.map((c) => c.id));
  const unknownDependencies: UnknownDependency[] = [];
  for (const c of contracts) {
    for (const dep of c.dependsOn) {
      const resolved = idByRef[dep] ?? dep;
      if (!ids.has(resolved)) unknownDependencies.push({ featureId: c.id, dependsOn: dep });
    }
  }

  return {
    ok: dangling.length === 0 && duplicateProduces.length === 0 && unknownDependencies.length === 0,
    dangling,
    duplicateProduces,
    unknownDependencies,
  };
}
