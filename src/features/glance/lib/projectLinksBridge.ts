// The frontend ↔ project-links bridge (#2253 → #3786 Phase 2) — the Glance L0 contracts are a GLOBAL
// store reached through `bsc project link …` (the same CLI an agent uses to learn what its project
// consumes / contracts with). The Zustand `projectLinks` slice is a write-through cache: `loadProjectLinks`
// hydrates it on boot, and each add/remove pushes through here. Contracts are global (no project key), so
// every call passes null. #3786 threads the optional `target` endpoint (a service / mcp server) through
// load + add.
import { bsc, bscRun } from "@/shared/lib/core/bsc";
import type { ProjectLink, ContractTarget, ContractTargetType } from "./projectLinks";
import type { AppType } from "@/features/planner";

const KINDS = ["api", "data", "events"];
const TARGET_TYPES: ContractTargetType[] = ["project", "service", "mcp"];

/** Coerce a raw `target` blob from the CLI into a {@link ContractTarget}, or `undefined` for a trivial
 *  project endpoint (no descriptors) — so a legacy project link stays byte-identical (no `target`) in the
 *  cache. Returns `undefined` on any malformed/unknown target so the link degrades to a project contract. */
function coerceTarget(raw: unknown): ContractTarget | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const type = TARGET_TYPES.includes(r.type as ContractTargetType) ? (r.type as ContractTargetType) : "project";
  const name = typeof r.name === "string" && r.name ? r.name : undefined;
  const url = typeof r.url === "string" && r.url ? r.url : undefined;
  const appType = typeof r.appType === "string" && r.appType ? (r.appType as AppType) : undefined;
  // A bare project endpoint carries no contract detail → leave `target` absent (byte-compat).
  if (type === "project" && !name && !url && !appType) return undefined;
  return { type, ...(name ? { name } : {}), ...(url ? { url } : {}), ...(appType ? { appType } : {}) };
}

/**
 * Load every contract via `bsc project link list --json`. Returns `null` when the bridge is unreachable
 * (no Tauri host / old binary) so the caller keeps its persisted cache rather than blanking it. NOT
 * `bscJson` — its degrade-to-`[]` would clobber the cache on a transient failure.
 */
export async function loadProjectLinks(): Promise<ProjectLink[] | null> {
  try {
    const out = await bsc(null, ["project", "link", "list", "--json"]);
    const rows = JSON.parse(out.trim() || "[]") as Record<string, unknown>[];
    return (rows ?? [])
      .filter(
        (l) =>
          typeof l.id === "string" && !!l.id && !!l.from && !!l.to && typeof l.kind === "string" && KINDS.includes(l.kind as string),
      )
      .map((l): ProjectLink => {
        const target = coerceTarget(l.target);
        return {
          id: l.id as string,
          from: l.from as string,
          to: l.to as string,
          kind: l.kind as ProjectLink["kind"],
          ...(target ? { target } : {}),
        };
      });
  } catch {
    return null;
  }
}

/** Write-through an add (`bsc project link add`), threading the optional `target` endpoint (#3786) as the
 *  `--target-type`/`--name`/`--url`/`--app-type` flags. Fire-and-forget; never throws (degrades to
 *  cache-only when the bridge/binary is absent). The store computes the id itself, so the printed id is
 *  unused. */
export async function pushProjectLink(from: string, to: string, kind: string, target?: ContractTarget): Promise<void> {
  const flags: string[] = [];
  if (target && target.type !== "project") flags.push("--target-type", target.type);
  if (target?.name) flags.push("--name", target.name);
  if (target?.url) flags.push("--url", target.url);
  if (target?.appType) flags.push("--app-type", target.appType);
  try { await bscRun(null, ["project", "link", "add", from, to, kind, ...flags]); } catch { /* bridge absent — cache-only */ }
}

/** Write-through a removal (`bsc project link remove <id>`). Never throws (see {@link pushProjectLink}). */
export async function dropProjectLink(id: string): Promise<void> {
  try { await bscRun(null, ["project", "link", "remove", id]); } catch { /* bridge absent — cache-only */ }
}
