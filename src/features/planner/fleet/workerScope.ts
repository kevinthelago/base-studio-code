// Build a fleet worker's scoped context markdown (#844) — the focused lane a worker
// loads as its `CLAUDE.local.md`, INSTEAD of the full planning spec. Workers used to
// inherit the hub's ~52KB planner `CLAUDE.md` (their worktrees sat under the hub, so
// Claude Code's cwd-and-ancestors `CLAUDE.md` walk picked it up); relocating worktrees
// out from under the hub removes that leak, and this gives each worker exactly the
// context it needs: the files and issues it owns, and the contracts it builds against. Pure +
// unit-tested; the Rust side (`write_worker_context`) writes it as the lead of the
// worktree's CLAUDE.local.md, ahead of the per-repo context, protocol, and skills.

import type { AgentStream } from "./planFleet";
import { buildWorkerDependencyBlock, type PlanDependency } from "../issues/dependencies";
import { COMMONS_STREAM_ID } from "./commonsGate";
import workerScopeEmbedded from "@data/fleet/worker-scope.json";
import { overlayFile } from "@/shared/lib/core/configOverrides";

// The fully-static prose blocks (maintenance-mode notice, the integration-interfaces paragraph, and the
// issue-lifecycle paragraph) are externalized to `@data/fleet/worker-scope.json` (#2145, epic #2027 tail)
// — editable without touching code + part of the exportable config bundle; the config-dir copy (#2047)
// overlays the embedded default via `overlayFile`. Only lines with NO interpolation moved; the heading,
// the owns/issues/deps bullets, and the repo-root-commons block stay inline (they interpolate runtime
// values / the `gatedOnCommons` flag), and the builder still assembles the whole markdown.
const SCOPE_PROSE = overlayFile("fleet/worker-scope.json", workerScopeEmbedded);

/** The project's {kit, theme} pairing (#2489) as the worker context needs it — the kit ref halves
 *  plus the chosen theme id. Sourced from plan.db's `ui` blob (`bsc plan ui get`, the planner's
 *  per-project record) falling back to the blueprint's pin. */
export interface WorkerUiPairing {
  kit?: { id: string; version: string };
  /** A `bsc ui theme` id. Absent ⇒ `"default"`. */
  themeId?: string;
}

/**
 * Fold the two pairing sources into the worker's {@link WorkerUiPairing} (#2489): plan.db's `ui`
 * blob (`bsc plan ui get` — the planner's per-project record) wins PER HALF, the project
 * blueprint's pin fills what it doesn't set (kit and/or themeId). Tolerant of the untyped blob
 * shape; `undefined` when neither source contributes anything (no block is inlined). Pure so the
 * fold is unit-testable; callers do the async reads.
 */
export function toWorkerUiPairing(
  planned: { kit?: { id?: unknown; version?: unknown } | null; themeId?: unknown } | null | undefined,
  pin?: { id: string; version: string; themeId?: string },
): WorkerUiPairing | undefined {
  const plannedKit =
    planned?.kit && typeof planned.kit.id === "string" && planned.kit.id && typeof planned.kit.version === "string" && planned.kit.version
      ? { id: planned.kit.id, version: planned.kit.version }
      : undefined;
  const kit = plannedKit ?? (pin ? { id: pin.id, version: pin.version } : undefined);
  const themeId =
    (typeof planned?.themeId === "string" && planned.themeId ? planned.themeId : undefined) ?? pin?.themeId;
  if (!kit && !themeId) return undefined;
  return { ...(kit ? { kit } : {}), ...(themeId ? { themeId } : {}) };
}

/**
 * Render the project's UI-palette pairing (#2489) as the worker-context block appended to the
 * scope — mirroring the dependencies-lock guardrail (#1111): the semantic token layer is
 * planner-owned and READ-ONLY for workers; the palette lives entirely in the swappable
 * `theme.css`. Returns "" when the project recorded no pairing (nothing to inline).
 */
export function buildWorkerUiThemeBlock(ui?: WorkerUiPairing): string {
  if (!ui || (!ui.kit && !ui.themeId)) return "";
  const theme = ui.themeId || "default";
  const kit = ui.kit ? `\`${ui.kit.id}@${ui.kit.version}\` component kit` : "component kit";
  return [
    "## UI palette (locked by the planner)",
    "",
    `This app is built on the ${kit} with the \`${theme}\` theme. Its stylesheet order is the`,
    "contract: `tokens.css` (the semantic token layer the kit components consume — `--card-*`/",
    "`--btn-*`/`--field-*`/`--chip-*`) → `theme.css` (the chosen theme's overrides — THE app's",
    "palette) → app styles. Both files are emitted into the app's styles dir by:",
    "",
    `    "$BSC_BIN" ui emit-css --theme ${theme} --out <styles dir>`,
    "",
    "**Do NOT edit `tokens.css`, and do NOT hand-roll palette values in component styles** — the",
    "token layer is read-only for you; the palette lives ENTIRELY in `theme.css`, so re-theming the",
    "app stays a one-file swap (re-run `emit-css` with another `--theme`). Components reference the",
    "semantic tokens, never raw colors. If a view genuinely needs a token the layer doesn't provide,",
    "request it from the director (`bsc-ask`) rather than adding it yourself.",
  ].join("\n");
}

/**
 * Render a stream's owned globs / issues / dependencies into the scope block that leads
 * a worker's `CLAUDE.local.md`. Kept deliberately small — the worker's job is to finish
 * its issues, not to hold the whole plan; cross-stream questions go to the director and
 * integration interfaces live in the contracts dir.
 *
 * `deps` is the LOCKED dependency manifest for this worker's repo (#1111): when present it's
 * appended as the planner-owned "Dependencies (locked)" block so the worker installs from a single
 * authority instead of adding its own (the source of parallel-worktree manifest collisions).
 *
 * `ui` is the project's recorded {kit, theme} pairing (#2489): when present it's appended as the
 * planner-owned "UI palette (locked)" block — token layer read-only, palette in theme.css.
 *
 * Returns a heading + bullet list. Empty fields are rendered as an explicit "none"/"all
 * within your owned paths" so the worker isn't left guessing whether the field was
 * omitted or genuinely empty.
 */
export function buildWorkerScope(stream: AgentStream, deps: PlanDependency[] = [], maintenance = false, ui?: WorkerUiPairing): string {
  const owns = stream.owns.length
    ? stream.owns.map((g) => `\`${g}\``).join(", ")
    : "(none assigned — confirm your lane with the director before writing)";
  const issues = stream.issues.length ? stream.issues.join(", ") : "(none yet — ask the director)";
  // The commons-landed sentinel (#851) is a Phase-0 gate, not a peer contract; surface it as the
  // commons note below rather than in the contracts line so it doesn't read as another stream's seam.
  const gatedOnCommons = stream.dependsOn.includes(COMMONS_STREAM_ID);
  const contractDeps = stream.dependsOn.filter((d) => d !== COMMONS_STREAM_ID);
  const streamDeps = contractDeps.length ? contractDeps.join(", ") : "none";

  const lines: string[] = [`# Your scope — ${stream.name}`, ""];
  if (maintenance) {
    lines.push(...SCOPE_PROSE.maintenance);
  }
  lines.push(
    "You are one of several Claude sessions building this project in parallel, working in your",
    `own git worktree on branch \`${stream.id}\`. This file is your lane — not the full plan.`,
    "",
    `- **You own:** ${owns}. Do not modify files outside your owned paths — another stream owns`,
    "  them; coordinate through the director instead of reaching in.",
    `- **Your issues:** ${issues}.`,
    `- **You build against the contracts of:** ${streamDeps}. Implement to their planned interface IN`,
    "  PARALLEL — do NOT wait for those streams to land; integration is verified at merge.",
    "",
    ...SCOPE_PROSE.integrationInterfaces,
    "**Repo-root commons are the director's, not yours** — `.gitignore`, `package.json`/lockfile,",
    "`tsconfig*`, `.github/workflows/**`, `.env.example`, formatter/linter config" + (gatedOnCommons ? " (already scaffolded on develop)" : "") + ". Do NOT",
    "edit them: for a new dependency, ignore entry, CI tweak, or env key, ask the director (`bsc-ask`)",
    "and pause (`bsc-wait`) — it lands the change and wakes you. (The scope hook blocks the write anyway.)",
    "",
    ...SCOPE_PROSE.issueLifecycle,
  );

  const depBlock = buildWorkerDependencyBlock(deps);
  if (depBlock) lines.push("", depBlock);

  const uiBlock = buildWorkerUiThemeBlock(ui);
  if (uiBlock) lines.push("", uiBlock);

  return lines.join("\n");
}
