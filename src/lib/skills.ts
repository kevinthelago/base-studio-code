// Pure helpers for the Skills feature — the SkillDef model, per-session resolution,
// catalog → definition templates, the parse of the planner's `skills.json` control
// file, and the conversion to the SKILL.md payloads written into a session's
// `.claude/skills/<slug>/SKILL.md`.
//
// Free of React / Tauri imports so it can be unit-tested and shared between the
// store, the Skills screen, and TerminalView. Mirrors `lib/extensions.ts` so the
// backend wiring (`ensure_session_settings`) is a structural twin.

export type SkillKind = "workflow" | "scaffold" | "codemod" | "review" | "docs";
export type SkillProfile = "build" | "review" | "docs" | "auto" | "sandbox";

export const SKILL_KINDS: SkillKind[] = ["workflow", "scaffold", "codemod", "review", "docs"];
export const SKILL_PROFILES: SkillProfile[] = ["build", "review", "docs", "auto", "sandbox"];

/**
 * A reusable capability bundle (prompt + bundled tools + profile guardrails) the
 * fleet can invoke. Scoped per-skill via {@link SkillDef.projects} ([] = global).
 */
export interface SkillDef {
  id: string;
  name: string;
  kind: SkillKind;
  description: string;
  /** The reusable procedure body the agent follows when it invokes the skill. */
  prompt: string;
  /** Tool names bundled with the skill (shown as kbd chips on the card). */
  tools: string[];
  /** Permission profiles allowed to invoke the skill. */
  profiles: SkillProfile[];
  enabled: boolean;
  /** Pinned skills are auto-available to the fleet. */
  pinned: boolean;
  /** `[]` = every project (global); otherwise the project ids it applies to. */
  projects: string[];
  /** Provenance label — "first-party" | "team" | "community" | … (display only). */
  source: string;
}

/** A planner-local seed shape: a {@link SkillDef} minus its store-assigned id. */
export type SkillSeed = Omit<SkillDef, "id">;

/**
 * The enabled skills that apply to a session in `projectId`: a def applies when it
 * is enabled AND either global (`projects` empty) or scoped to this project. An
 * empty `projectId` (no project) yields only global defs. (Mirror of
 * {@link resolveExtensions}.)
 */
export function resolveSkills(all: SkillDef[], projectId: string): SkillDef[] {
  return all.filter(
    s => s.enabled && (s.projects.length === 0 || (!!projectId && s.projects.includes(projectId))),
  );
}

/** Slugify a skill name into a directory-safe slug: lowercase, hyphenated, trimmed. */
export function skillSlug(name: string): string {
  return (
    name.toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "skill"
  );
}

// ── Backend payload ───────────────────────────────────────────────────────────
// Shape handed to `ensure_session_settings`; field names match the Rust struct.
// Each becomes `<cwd>/.claude/skills/<slug>/SKILL.md` — name/description/allowed-tools
// frontmatter + the prompt body — mirroring how MCP servers become `.mcp.json`.

export interface SkillCfg {
  slug: string;
  name: string;
  description: string;
  tools: string[];
  prompt: string;
}

/** A `SkillDef` → its SKILL.md payload, or null if it lacks the minimum (name + prompt). */
export function toSkillCfg(s: SkillDef): SkillCfg | null {
  const name = s.name.trim();
  const prompt = s.prompt.trim();
  if (!name || !prompt) return null;
  return {
    slug: skillSlug(name),
    name,
    description: s.description.trim(),
    tools: s.tools.filter(Boolean),
    prompt,
  };
}

/** A resolved skill list → the backend payload list. Incomplete skills are dropped
 *  and the first writer wins on a slug collision (a stable, predictable directory). */
export function toSkillCfgs(defs: SkillDef[]): SkillCfg[] {
  const out: SkillCfg[] = [];
  const seen = new Set<string>();
  for (const d of defs) {
    const cfg = toSkillCfg(d);
    if (!cfg || seen.has(cfg.slug)) continue;
    seen.add(cfg.slug);
    out.push(cfg);
  }
  return out;
}

// ── Catalog templates ─────────────────────────────────────────────────────────
// Pre-filled config for the well-known "Add a skill" catalog entries (keyed by name).
// Unknown names fall back to a blank workflow skill the user fills in.

const CATALOG_TEMPLATES: Record<string, Partial<SkillSeed>> = {
  "Open a clean PR": {
    kind: "workflow",
    description: "Write a conventional-commit title, a summary + test-plan body from the diff, link the issue, and request review.",
    prompt:
      "Open a pull request for the current branch:\n" +
      "1. Read the diff vs the base branch to summarize what changed.\n" +
      "2. Write a conventional-commit title (feat/fix/chore(scope): …).\n" +
      "3. Body: a short summary, a bulleted test plan, and `Closes #<issue>`.\n" +
      "4. Push the branch and open the PR targeting develop; request review.",
    tools: ["create_pr", "git_diff"],
    profiles: ["build", "auto"],
  },
  "Scaffold a Tauri command": {
    kind: "scaffold",
    description: "Add a #[tauri::command], wire it into the invoke handler, generate the TS binding, and stub a test.",
    prompt:
      "Scaffold a new Tauri command end-to-end:\n" +
      "1. Add the `#[tauri::command]` fn in src-tauri/src/lib.rs.\n" +
      "2. Register it in the `invoke_handler` generate list.\n" +
      "3. Add the typed `invoke(...)` binding on the frontend.\n" +
      "4. Stub a `#[cfg(test)]` unit test for the new command.",
    tools: ["edit", "grep", "cargo_test"],
    profiles: ["build"],
  },
  "Triage a failing test": {
    kind: "review",
    description: "Reproduce the failure, bisect the offending change, propose a minimal fix, and re-run the suite.",
    prompt:
      "Triage a failing test:\n" +
      "1. Run the suite and capture the exact failure.\n" +
      "2. Bisect to the change that introduced it.\n" +
      "3. Propose the minimal fix and apply it.\n" +
      "4. Re-run the suite and confirm green before handing back.",
    tools: ["bash", "git_log", "edit"],
    profiles: ["build", "review"],
  },
  "Project-wide rename": {
    kind: "codemod",
    description: "Type-aware symbol rename across Rust + TS, updating imports and call-sites, verified with a typecheck.",
    prompt:
      "Rename a symbol across the codebase:\n" +
      "1. Find every definition, import, and call-site of the symbol.\n" +
      "2. Apply a type-aware rename across Rust + TypeScript.\n" +
      "3. Update imports and re-exports.\n" +
      "4. Verify with `npm run typecheck` + `cargo check`.",
    tools: ["grep", "edit", "typecheck"],
    profiles: ["build"],
  },
  "Security review pass": {
    kind: "review",
    description: "Read-only sweep for secrets, unsafe blocks, missing auth checks, and injection sinks — inline comments only.",
    prompt:
      "Run a read-only security review of the current diff:\n" +
      "1. Scan for committed secrets and credentials.\n" +
      "2. Flag unsafe blocks, missing auth checks, and injection sinks.\n" +
      "3. Leave inline review comments only — never edit code.",
    tools: ["grep", "review_comment"],
    profiles: ["review", "sandbox"],
  },
  "Generate API docs": {
    kind: "docs",
    description: "Derive reference docs + a changelog entry from a merged contract, write them to /docs, and open a docs-only PR.",
    prompt:
      "Generate API reference docs:\n" +
      "1. Read the merged contract / route definitions.\n" +
      "2. Derive reference docs + a changelog entry.\n" +
      "3. Write them under /docs.\n" +
      "4. Open a docs-only PR.",
    tools: ["edit", "create_pr"],
    profiles: ["docs"],
  },
};

/** A ready-to-add `SkillSeed` for a catalog entry — enabled + global + pinned by
 *  default; the caller assigns the id. Unknown names yield a blank workflow skill. */
export function defFromCatalog(name: string): SkillSeed {
  const t = CATALOG_TEMPLATES[name];
  if (!t) return { ...blankSkill(), name };
  return {
    name,
    kind: t.kind ?? "workflow",
    description: t.description ?? "",
    prompt: t.prompt ?? "",
    tools: t.tools ?? [],
    profiles: t.profiles ?? ["build"],
    enabled: true,
    pinned: true,
    projects: [],
    source: "first-party",
  };
}

/** A blank custom skill, ready for the add-custom form (disabled + global). */
export function blankSkill(): SkillSeed {
  return {
    name: "",
    kind: "workflow",
    description: "",
    prompt: "",
    tools: [],
    profiles: ["build"],
    enabled: false,
    pinned: false,
    projects: [],
    source: "team",
  };
}

// ── Planner control file ──────────────────────────────────────────────────────
// The planner authors `skills.json` in the project hub (the authoritative channel
// it polls), shaped as a JSON array of skill objects. We parse it tolerantly into
// seeds the store upserts into the global library (mirrors `commands.json`).

const VALID_KINDS = new Set<string>(SKILL_KINDS);
const VALID_PROFILES = new Set<string>(SKILL_PROFILES);

/** Coerce one loosely-typed planner entry into a {@link SkillSeed}, or null if it
 *  has no usable name. Unknown kinds default to "workflow"; bad profiles are dropped. */
function coerceSeed(raw: unknown): SkillSeed | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) return null;
  const kind = typeof o.kind === "string" && VALID_KINDS.has(o.kind) ? (o.kind as SkillKind) : "workflow";
  const tools = Array.isArray(o.tools) ? o.tools.filter((t): t is string => typeof t === "string") : [];
  const profilesRaw = Array.isArray(o.profiles)
    ? o.profiles.filter((p): p is string => typeof p === "string" && VALID_PROFILES.has(p))
    : [];
  return {
    name,
    kind,
    description: typeof o.description === "string" ? o.description : "",
    prompt: typeof o.prompt === "string" ? o.prompt : "",
    tools,
    profiles: (profilesRaw.length ? profilesRaw : ["build"]) as SkillProfile[],
    enabled: true,
    pinned: o.pinned === true,
    projects: [],
    source: typeof o.source === "string" ? o.source : "planner",
  };
}

/** Parse the planner's `skills.json` text into seeds. Returns `[]` for any non-array
 *  / unparseable input so a malformed control file never throws into the poller. */
export function parseSkillsFile(text: string): SkillSeed[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.map(coerceSeed).filter((s): s is SkillSeed => s !== null);
}

/**
 * Upsert parsed planner seeds into an existing library, matching by skill name
 * (case-insensitive). An existing skill keeps its id, enabled, pinned, and project
 * scope (user-owned), but takes the planner's content (kind/description/prompt/
 * tools/profiles). New seeds are appended via `mkId`. Pure — the store supplies the
 * id factory and the resulting list.
 */
export function upsertSkillSeeds(
  existing: SkillDef[],
  seeds: SkillSeed[],
  mkId: () => string,
): SkillDef[] {
  const byName = new Map(existing.map(s => [s.name.trim().toLowerCase(), s]));
  const next = [...existing];
  for (const seed of seeds) {
    const key = seed.name.trim().toLowerCase();
    const cur = byName.get(key);
    if (cur) {
      const idx = next.findIndex(s => s.id === cur.id);
      next[idx] = {
        ...cur,
        kind: seed.kind,
        description: seed.description,
        prompt: seed.prompt,
        tools: seed.tools,
        profiles: seed.profiles,
        source: seed.source,
      };
    } else {
      const created: SkillDef = { ...seed, id: mkId() };
      next.push(created);
      byName.set(key, created);
    }
  }
  return next;
}
