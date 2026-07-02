// ── Manifest writers (publish-time scaffold seed, #1111) ──────────────────────────
// Additive + never-clobber: an existing pinned version always wins over the planned one, so
// re-publishing or seeding a hand-edited manifest never downgrades or fights a real dependency.

import type { PlanDependency } from "@/features/planner/issues/dependencyTypes";

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
