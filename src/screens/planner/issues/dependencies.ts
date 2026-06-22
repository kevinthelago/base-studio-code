// The dependency manifest (#1111): the authoritative, planner-owned list of the libraries every
// repo depends on, defined ONCE during planning so the fleet doesn't each add/redefine deps in
// parallel worktrees and collide at integration. The planner writes `dependencies.json` (surfaced
// by the poll like `features.json`); the Dependencies gate reads its count; publish pre-populates
// each repo's real `package.json` / `Cargo.toml` from it; and each worker's CLAUDE.local.md inlines
// the locked set with a "don't touch the manifests" guardrail. Pure + tolerant — no React/Tauri.

/** The dependency manifest file stem (JSON: `dependencies.json` — an array of dependency objects).
 *  Surfaced by the poll like `features.json`; not rendered as a plan section. */
export const DEPENDENCIES_KEY = "dependencies";

/** A package-manager ecosystem the manifest can target. */
export type DependencyEcosystem = "npm" | "cargo";

/** One locked dependency: which repo + ecosystem it belongs to, its name + version, and why. */
export interface PlanDependency {
  /** `owner/repo` this applies to. Absent ⇒ applies to every repo of its ecosystem. */
  repo?: string;
  /** The package manager this dependency installs through. */
  ecosystem: DependencyEcosystem;
  /** Package / crate name. */
  name: string;
  /** Version range (npm: `^1.2.0`) or version (cargo: `1.2`). Absent ⇒ `*` / latest. */
  version?: string;
  /** A development-only dependency (devDependencies / [dev-dependencies]). */
  dev?: boolean;
  /** One-line rationale — surfaced in the worker manifest so the choice is legible. */
  why?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Parse `dependencies.json` into a clean list. Accepts a bare JSON array of dependency objects, or
 * `{ "dependencies": [...] }`. Tolerant: bad JSON ⇒ []; an entry without a name or a recognized
 * ecosystem (`npm` | `cargo`) is dropped; duplicates (same repo+ecosystem+name) are de-duped, first
 * write winning.
 */
export function parseDependenciesFile(raw: string): PlanDependency[] {
  const t = (raw ?? "").trim();
  if (!t) return [];
  let data: unknown;
  try { data = JSON.parse(t); } catch { return []; }
  const arr: unknown[] = Array.isArray(data)
    ? data
    : (data && typeof data === "object" && Array.isArray((data as { dependencies?: unknown }).dependencies))
      ? (data as { dependencies: unknown[] }).dependencies
      : [];
  const out: PlanDependency[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = str(o.name);
    const eco = str(o.ecosystem)?.toLowerCase();
    if (!name || (eco !== "npm" && eco !== "cargo")) continue;
    const repo = str(o.repo);
    const key = `${repo ?? "*"}|${eco}|${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      repo,
      ecosystem: eco,
      name,
      version: str(o.version),
      dev: o.dev === true,
      why: str(o.why),
    });
  }
  return out;
}

/** The dependencies that apply to a given repo: those tagged with that `owner/repo`, plus the
 *  ecosystem-wide ones (no `repo`). */
export function depsForRepo(deps: PlanDependency[], fullName: string): PlanDependency[] {
  return deps.filter((d) => !d.repo || d.repo === fullName);
}

/** Split a repo's deps into npm / cargo buckets (for the manifest writers + the worker block). */
export function bucketByEcosystem(deps: PlanDependency[]): Record<DependencyEcosystem, PlanDependency[]> {
  return {
    npm: deps.filter((d) => d.ecosystem === "npm"),
    cargo: deps.filter((d) => d.ecosystem === "cargo"),
  };
}

// ── Manifest writers (publish-time scaffold seed, #1111) ──────────────────────────
// Additive + never-clobber: an existing pinned version always wins over the planned one, so
// re-publishing or seeding a hand-edited manifest never downgrades or fights a real dependency.

/** A crate/package name reduced to a valid bare identifier for a generated manifest. */
function safePkgName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "app";
}

/**
 * Merge the npm dependencies into a `package.json`, returning the pretty-printed JSON (or `null`
 * when there are none to add). `existing` is the current file content (or null/empty for a fresh
 * repo — a minimal private package is generated). An npm dep already present in the manifest keeps
 * its pinned version; only genuinely missing deps are added.
 */
export function mergeIntoPackageJson(existing: string | null, pkgName: string, deps: PlanDependency[]): string | null {
  const npm = deps.filter((d) => d.ecosystem === "npm");
  if (!npm.length) return null;

  let json: Record<string, unknown> = {};
  if (existing && existing.trim()) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    } catch { /* unparseable — treat as fresh rather than clobber blindly */ return null; }
  } else {
    json = { name: safePkgName(pkgName), version: "0.1.0", private: true };
  }

  const ensure = (field: "dependencies" | "devDependencies") => {
    const cur = json[field];
    return (cur && typeof cur === "object" && !Array.isArray(cur)) ? { ...(cur as Record<string, string>) } : {};
  };
  const runtime = ensure("dependencies");
  const development = ensure("devDependencies");

  for (const d of npm) {
    const target = d.dev ? development : runtime;
    if (target[d.name] === undefined) target[d.name] = d.version ?? "*"; // never clobber a pinned version
  }
  if (Object.keys(runtime).length) json.dependencies = sortedRecord(runtime);
  if (Object.keys(development).length) json.devDependencies = sortedRecord(development);

  return JSON.stringify(json, null, 2) + "\n";
}

function sortedRecord(r: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k]]));
}

/** A single `name = "version"` Cargo dependency line. */
function cargoDepLine(d: PlanDependency): string {
  return `${d.name} = "${d.version ?? "*"}"`;
}

/**
 * Merge the cargo dependencies into a `Cargo.toml`, returning the file content (or `null` when
 * there are none to add). With no existing manifest a minimal valid one is generated (`[package]`
 * + `[dependencies]`); with an existing one, missing deps are appended to its `[dependencies]` /
 * `[dev-dependencies]` table (a dep already named in the file is left untouched — never clobbered).
 * Line-oriented on purpose: it adds without re-serializing, so hand-written formatting/comments
 * survive.
 */
export function mergeIntoCargoToml(existing: string | null, crateName: string, deps: PlanDependency[]): string | null {
  const cargo = deps.filter((d) => d.ecosystem === "cargo");
  if (!cargo.length) return null;

  if (!existing || !existing.trim()) {
    const runtime = cargo.filter((d) => !d.dev);
    const development = cargo.filter((d) => d.dev);
    const out = [
      "[package]",
      `name = "${safePkgName(crateName)}"`,
      `version = "0.1.0"`,
      `edition = "2021"`,
      "",
      "[dependencies]",
      ...runtime.map(cargoDepLine),
    ];
    if (development.length) out.push("", "[dev-dependencies]", ...development.map(cargoDepLine));
    return out.join("\n") + "\n";
  }

  // Append-only into the existing file: add a missing dep under its table, creating the table if needed.
  const named = new Set(
    [...existing.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1].toLowerCase()),
  );
  let out = existing.replace(/\s*$/, "\n");
  const addToTable = (header: string, table: PlanDependency[]) => {
    const missing = table.filter((d) => !named.has(d.name.toLowerCase()));
    if (!missing.length) return;
    const lines = missing.map(cargoDepLine);
    const headerRe = new RegExp(`^\\[${header.replace(/[-]/g, "\\$&")}\\]\\s*$`, "m");
    const m = headerRe.exec(out);
    if (m) {
      // Insert right after the table header.
      const insertAt = m.index + m[0].length;
      out = out.slice(0, insertAt) + "\n" + lines.join("\n") + out.slice(insertAt);
    } else {
      out = out.replace(/\n*$/, "\n") + `\n[${header}]\n` + lines.join("\n") + "\n";
    }
    missing.forEach((d) => named.add(d.name.toLowerCase()));
  };
  addToTable("dependencies", cargo.filter((d) => !d.dev));
  addToTable("dev-dependencies", cargo.filter((d) => d.dev));
  return out;
}

/**
 * Render the locked dependency set for ONE repo as the worker-context block inlined into its
 * CLAUDE.local.md (#1111) — the single authority every worker reads, with the guardrail that the
 * manifests are planner-owned and new deps route through the director. Returns "" when the repo has
 * no locked deps (nothing to inline).
 */
export function buildWorkerDependencyBlock(deps: PlanDependency[]): string {
  if (!deps.length) return "";
  const { npm, cargo } = bucketByEcosystem(deps);
  const fmt = (d: PlanDependency) => {
    const ver = d.version ? `@${d.version}` : "";
    const dev = d.dev ? " *(dev)*" : "";
    const why = d.why ? ` — ${d.why}` : "";
    return `  - \`${d.name}${ver}\`${dev}${why}`;
  };
  const lines = ["## Dependencies (locked by the planner)", ""];
  if (npm.length) lines.push("**npm** (`package.json`):", ...npm.map(fmt), "");
  if (cargo.length) lines.push("**cargo** (`Cargo.toml`):", ...cargo.map(fmt), "");
  lines.push(
    "These are already present in the repo's manifests — installing them is enough. **Do NOT add to or",
    "edit `package.json` / `Cargo.toml`** (the role gate blocks it): redefining deps in parallel",
    "worktrees is exactly what collides at integration. If you genuinely need a new dependency, request",
    "it from the director (`bsc-ask`) rather than adding it yourself.",
  );
  return lines.join("\n");
}
