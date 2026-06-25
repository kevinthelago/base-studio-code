// The dependency manifest (#1111/#1127): the authoritative, planner-owned list of the libraries every
// repo depends on, defined ONCE during planning so the fleet doesn't each add/redefine deps in
// parallel worktrees and collide at integration. The planner records it via `bsc-plan deps set` into
// plan.db (#1191 — was a raw `dependencies.json`); the poll reflects the stored manifest into the
// DEPENDENCIES section, the Dependencies gate reads its count, publish pre-populates each repo's real
// `package.json` / `Cargo.toml` from it, and each worker's CLAUDE.local.md inlines the locked set with
// a "don't touch the manifests" guardrail. This module stays a pure + tolerant manifest model (it
// parses the same shape whether it arrives from plan.db or a legacy file) — no React/Tauri.

/** The dependency-manifest section key. The stored manifest (`{ dependencies, registries }`) is
 *  DB-owned (#1191): the poll mirrors `plan_get_deps` here. Surfaced by the poll like `features.json`;
 *  not rendered as a plan section. The legacy `dependencies.json` file shares this key during the
 *  one-time import. */
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
  /** The registry this is fetched from (#1127) — a KEY into the manifest's `registries` map. Absent
   *  ⇒ the ecosystem's public default (npm registry / crates.io). A non-public source generates the
   *  registry config (`.npmrc` / `.cargo/config.toml`) at publish. */
  source?: string;
}

/** A non-default registry a dependency is fetched from (#1127). The `auth` token's VALUE lives in the
 *  host vault — only its secret NAME is recorded here (and as a deploy secret). */
export interface DependencyRegistry {
  /** Registry base URL (npm) / index URL (cargo). */
  url: string;
  /** npm scope this registry serves (e.g. `@acme`). Absent ⇒ the npm default registry. Ignored by cargo. */
  scope?: string;
  /** Name of the auth-token secret (value lives in the host vault; recorded as a deploy secret). */
  auth?: string;
}

/** The full dependency manifest (#1127): the locked libraries plus the non-default registries they
 *  come from, keyed by the `source` each dependency references. */
export interface DependencyManifest {
  dependencies: PlanDependency[];
  registries: Record<string, DependencyRegistry>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Parse a stored dependency manifest (the plan.db blob, or a legacy `dependencies.json`) into the
 * full manifest (#1127). Accepts a bare JSON array of dependency
 * objects (the #1111 form, ⇒ no registries), or `{ "dependencies": [...], "registries": {...} }`.
 * Tolerant: bad JSON ⇒ empty manifest; a dependency without a name or a recognized ecosystem
 * (`npm` | `cargo`) is dropped; duplicates (same repo+ecosystem+name) are de-duped, first write
 * winning; a registry without a string `url` is dropped.
 */
export function parseDependencyManifest(raw: string): DependencyManifest {
  const empty: DependencyManifest = { dependencies: [], registries: {} };
  const t = (raw ?? "").trim();
  if (!t) return empty;
  let data: unknown;
  try { data = JSON.parse(t); } catch { return empty; }
  const obj = (data && typeof data === "object" && !Array.isArray(data)) ? data as Record<string, unknown> : null;
  const arr: unknown[] = Array.isArray(data)
    ? data
    : (obj && Array.isArray(obj.dependencies)) ? obj.dependencies as unknown[] : [];

  const dependencies: PlanDependency[] = [];
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
    dependencies.push({
      repo,
      ecosystem: eco,
      name,
      version: str(o.version),
      dev: o.dev === true,
      why: str(o.why),
      source: str(o.source),
    });
  }

  const registries: Record<string, DependencyRegistry> = {};
  const regRaw = obj && obj.registries && typeof obj.registries === "object" && !Array.isArray(obj.registries)
    ? obj.registries as Record<string, unknown> : {};
  for (const [k, v] of Object.entries(regRaw)) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const url = str(r.url);
    if (!url) continue;
    registries[k] = { url, scope: str(r.scope), auth: str(r.auth) };
  }
  return { dependencies, registries };
}

/** Parse just the dependency list (#1111 back-compat — the count/gate/seeding callers). */
export function parseDependenciesFile(raw: string): PlanDependency[] {
  return parseDependencyManifest(raw).dependencies;
}

/** The dependencies that apply to a given repo: those tagged with that `owner/repo`, plus the
 *  ecosystem-wide ones (no `repo`). */
export function depsForRepo(deps: PlanDependency[], fullName: string): PlanDependency[] {
  return deps.filter((d) => !d.repo || d.repo === fullName);
}

/** A source (registry) the project pulls from, with the deps fetched through it (#1127 UI). The
 *  public default per ecosystem is synthesized when a dep carries no `source`. */
export interface DependencySourceGroup {
  /** Stable key — the registry key, or `"npm"` / `"cargo"` for the ecosystem default. */
  key: string;
  name: string;
  /** True when this source is a non-default (private) registry. */
  private: boolean;
  url: string;
  scope?: string;
  /** Auth-token secret name (private sources only). */
  auth?: string;
  deps: PlanDependency[];
}

const PUBLIC_SOURCE: Record<DependencyEcosystem, { name: string; url: string }> = {
  npm:   { name: "npm registry", url: "registry.npmjs.org" },
  cargo: { name: "crates.io",    url: "crates.io" },
};

/** Group locked deps BY the source each is pulled from (#1127): one group per non-default registry
 *  referenced, plus one per ecosystem-default for deps without a `source`. Sorted defaults-first
 *  then by name, so the view is deterministic. Pure. */
export function groupDependenciesBySource(
  deps: PlanDependency[],
  registries: Record<string, DependencyRegistry>,
): DependencySourceGroup[] {
  const groups = new Map<string, DependencySourceGroup>();
  for (const dep of deps) {
    const reg = dep.source ? registries[dep.source] : undefined;
    // A dep whose `source` isn't a known registry falls back to the ecosystem's public default.
    const key = reg ? dep.source! : dep.ecosystem;
    let g = groups.get(key);
    if (!g) {
      g = reg
        ? { key, name: dep.source!, private: true, url: reg.url, scope: reg.scope, auth: reg.auth, deps: [] }
        : { key, name: PUBLIC_SOURCE[dep.ecosystem].name, private: false, url: PUBLIC_SOURCE[dep.ecosystem].url, deps: [] };
      groups.set(key, g);
    }
    g.deps.push(dep);
  }
  return [...groups.values()].sort((a, b) =>
    a.private === b.private ? a.name.localeCompare(b.name) : a.private ? 1 : -1);
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

/** A single Cargo dependency line. A dep with a non-default `source` takes the table form so cargo
 *  resolves it against the named registry: `name = { version = "x", registry = "src" }`. */
function cargoDepLine(d: PlanDependency): string {
  const ver = d.version ?? "*";
  return d.source
    ? `${d.name} = { version = "${ver}", registry = "${d.source}" }`
    : `${d.name} = "${ver}"`;
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

// ── Registry config writers (#1127) ──────────────────────────────────────────────
// Generate the source/registry config so a private dependency is fetchable from the first commit.
// Only the registries a repo's deps actually reference are emitted; public-only repos get nothing.

/** The `//host[/path]/` key npm's `.npmrc` uses for an auth token, derived from a registry URL. */
function npmrcHostKey(url: string): string {
  return url.replace(/^https?:/i, "").replace(/\/?$/, "/");
}

/** The registry KEYs (sorted, deterministic) that a repo's deps of one ecosystem reference and that
 *  are actually defined in the registries map. */
function usedRegistries(registries: Record<string, DependencyRegistry>, deps: PlanDependency[], eco: DependencyEcosystem): string[] {
  const used = new Set(deps.filter((d) => d.ecosystem === eco && d.source && registries[d.source]).map((d) => d.source!));
  return [...used].sort();
}

/**
 * Build a repo's `.npmrc` from the registries its npm deps reference (#1127): a scoped registry as
 * `@scope:registry=<url>`, an unscoped one as the default `registry=<url>`, plus a `${SECRET}` auth
 * token line when the registry declares one. Returns null when no npm dep uses a private source.
 */
export function buildNpmrc(registries: Record<string, DependencyRegistry>, deps: PlanDependency[]): string | null {
  const keys = usedRegistries(registries, deps, "npm");
  if (!keys.length) return null;
  const lines: string[] = [];
  for (const key of keys) {
    const r = registries[key];
    lines.push(r.scope ? `${r.scope}:registry=${r.url}` : `registry=${r.url}`);
    if (r.auth) lines.push(`${npmrcHostKey(r.url)}:_authToken=\${${r.auth}}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Build a repo's `.cargo/config.toml` from the registries its cargo deps reference (#1127) — one
 * `[registries.<name>]` table with the index URL each. Returns null when no cargo dep uses a private
 * source. (Cargo reads the token from `CARGO_REGISTRIES_<NAME>_TOKEN`, kept out of the file.)
 */
export function buildCargoConfig(registries: Record<string, DependencyRegistry>, deps: PlanDependency[]): string | null {
  const keys = usedRegistries(registries, deps, "cargo");
  if (!keys.length) return null;
  const lines: string[] = [];
  for (const key of keys) lines.push(`[registries.${key}]`, `index = "${registries[key].url}"`, "");
  return lines.join("\n").replace(/\n+$/, "\n");
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
    const src = d.source ? ` *(from \`${d.source}\` registry)*` : "";
    const why = d.why ? ` — ${d.why}` : "";
    return `  - \`${d.name}${ver}\`${dev}${src}${why}`;
  };
  const hasSource = deps.some((d) => d.source);
  const lines = ["## Dependencies (locked by the planner)", ""];
  if (npm.length) lines.push("**npm** (`package.json`):", ...npm.map(fmt), "");
  if (cargo.length) lines.push("**cargo** (`Cargo.toml`):", ...cargo.map(fmt), "");
  lines.push(
    "These are already present in the repo's manifests — installing them is enough. **Do NOT add to or",
    "edit `package.json` / `Cargo.toml`** (the role gate blocks it): redefining deps in parallel",
    "worktrees is exactly what collides at integration. If you genuinely need a new dependency, request",
    "it from the director (`bsc-ask`) rather than adding it yourself.",
  );
  if (hasSource) {
    lines.push(
      "",
      "Private-registry sources are already wired in `.npmrc` / `.cargo/config.toml` (their auth tokens",
      "come from the environment) — don't reconfigure them.",
    );
  }
  return lines.join("\n");
}
