// Dead-code / unused-dependency scanning (#626, Refactor & Cleanup blueprint, slice a).
// The Rust `scan_dead_code` command runs an allowlisted tool in a repo and returns its
// raw output; these PURE parsers turn that output into structured DeadCodeFindings.
// Findings are CANDIDATES — a later slice has an agent verify each before any removal
// (static tools have false positives: dynamic refs, public API, test-only use).

import { invoke } from "@tauri-apps/api/core";

export type DeadCodeKind = "unused-dep" | "unused-export" | "unused-file" | "unreachable";

export interface DeadCodeFinding {
  kind: DeadCodeKind;
  /** File the finding lives in (or package.json / Cargo.toml for a dependency). */
  path: string;
  /** The dependency or export name, when applicable. */
  symbol?: string;
  detail: string;
  tool: string;
  /** Static-tool confidence — drives whether verification is required before acting. */
  confidence: "high" | "medium" | "low";
}

/** Mirrors the Rust ScanResult. */
export interface ScanResult { tool: string; ran: boolean; exitCode?: number | null; stdout: string; stderr: string; error?: string | null }

/** A scanner the UI can offer, grouped by stack. */
export interface Scanner { tool: string; label: string; stack: "js" | "rust"; finds: DeadCodeKind }
export const DEAD_CODE_SCANNERS: Scanner[] = [
  { tool: "depcheck", label: "Unused dependencies (depcheck)", stack: "js", finds: "unused-dep" },
  { tool: "ts-prune", label: "Unused exports (ts-prune)", stack: "js", finds: "unused-export" },
  { tool: "cargo-machete", label: "Unused crates (cargo-machete)", stack: "rust", finds: "unused-dep" },
];

// ── parsers (pure) ────────────────────────────────────────────────────────────

/** depcheck `--json`: { dependencies: [...], devDependencies: [...], missing: {...} }. */
export function parseDepcheck(stdout: string): DeadCodeFinding[] {
  let j: { dependencies?: unknown; devDependencies?: unknown };
  try { j = JSON.parse(stdout); } catch { return []; }
  const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return [...names(j.dependencies), ...names(j.devDependencies)].map((name) => ({
    kind: "unused-dep", path: "package.json", symbol: name, detail: "declared but never imported", tool: "depcheck", confidence: "medium",
  }));
}

/** ts-prune lines: `path:line - name` (skip the `(used in module)` self-references). */
export function parseTsPrune(stdout: string): DeadCodeFinding[] {
  const out: DeadCodeFinding[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /\(used in module\)/.test(line)) continue;
    const m = line.match(/^(.+?):(\d+)\s+-\s+(\S+)/);
    if (!m) continue;
    out.push({ kind: "unused-export", path: m[1], symbol: m[3], detail: `exported but unused (line ${m[2]})`, tool: "ts-prune", confidence: "medium" });
  }
  return out;
}

/** cargo-machete text: indented dep names under `<crate> -- <path>/Cargo.toml:`. */
export function parseCargoMachete(stdout: string): DeadCodeFinding[] {
  const out: DeadCodeFinding[] = [];
  let manifest = "Cargo.toml";
  for (const raw of stdout.split(/\r?\n/)) {
    const mf = raw.match(/--\s+(\S*Cargo\.toml):/i);
    if (mf) { manifest = mf[1]; continue; }
    const dep = raw.match(/^\s+(\S+)\s*$/); // indented single token = an unused crate
    if (dep) out.push({ kind: "unused-dep", path: manifest, symbol: dep[1], detail: "declared but unused crate", tool: "cargo-machete", confidence: "medium" });
  }
  return out;
}

const PARSERS: Record<string, (stdout: string) => DeadCodeFinding[]> = {
  depcheck: parseDepcheck, "ts-prune": parseTsPrune, "cargo-machete": parseCargoMachete,
};

export interface ScanOutcome { findings: DeadCodeFinding[]; ran: boolean; error?: string }

/** Run a scanner in a repo and parse its findings. Never throws. */
export async function scanDeadCode(args: { repoPath: string; tool: string }): Promise<ScanOutcome> {
  let res: ScanResult;
  try {
    res = await invoke<ScanResult>("scan_dead_code", { repoPath: args.repoPath, tool: args.tool });
  } catch (e) {
    return { findings: [], ran: false, error: String(e) };
  }
  if (!res.ran) return { findings: [], ran: false, error: res.error ?? "scan could not run" };
  const parser = PARSERS[args.tool];
  return { findings: parser ? parser(res.stdout) : [], ran: true };
}
