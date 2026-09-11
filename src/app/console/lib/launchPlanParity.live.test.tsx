// @vitest-environment jsdom
/**
 * LAUNCH-PLAN PARITY — what TerminalView + sessionLaunch ACTUALLY send today, for real panes.
 *
 * Slice 1 of `epic-the-frontend-derives-its-state-from-the-crates` adds a Rust resolver
 * (`bsc session launch-plan <paneId> --json`) that must reproduce the launch payload the frontend
 * composes, and slice 2a extends it to every kind of pane the renderer launches. This file is the
 * TypeScript half of that proof, and it measures by EXECUTING the real code rather than re-deriving it:
 * the real store writers seed each pane exactly as its launching surface does, the real `TerminalView`
 * mounts, and `invoke` is mocked only to CAPTURE the `ensure_session_settings` and `pty_create`
 * arguments it sends.
 *
 * OPT-IN AND LIVE. It reads this machine's real stores (plan.db, personas, skills, requests,
 * `app-state.json`, the config dir), so it cannot run in CI and costs nothing unless asked for:
 *
 *   BSC_LAUNCH_PARITY=1 BSC_LAUNCH_PARITY_OUT=<dir> [BSC_LAUNCH_PARITY_BIN=<bsc>] \
 *     npx vitest run src/app/console/lib/launchPlanParity.live.test.tsx
 *
 * ONE BINARY FOR BOTH SIDES. When `BSC_LAUNCH_PARITY_BIN` is set, the renderer's `bsc` reads go through
 * it too, so the surface catalog and the crate drills the two sides read are the same build's — a surface
 * charter is taught from that drill, and an installed `bsc` older than the build under test would make
 * the renderer quote verbs the verb's own binary does not list.
 *
 * READ-ONLY BY CONSTRUCTION. Every `bsc` call the app would make is routed to the real binary ONLY
 * when it is a read (`list` / `get` / `drill`); anything else is swallowed and recorded, so hydrating the
 * library can never push a persona or skill back into a real store. Secret VALUES never enter the
 * store: a present credential is replaced by `<secret:NAME>`, so the captured env shows which
 * variable carries which secret without carrying it.
 *
 * Config overlays are PRIMED the way `main.tsx` primes them — `get_config_files` answered from the
 * real config dir — BEFORE any app module is imported, because those modules build their consts at
 * import time. That is why every app import below is dynamic.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalView as TerminalViewType } from "@/app/console/panes/views/TerminalView";

// xterm cannot initialise in jsdom. The global stub in `src/test/setup.ts` has no `parser`, which the
// launch effect needs, so this is the richer stub TerminalView's own record tests use.
vi.mock("@xterm/xterm", () => {
  class Terminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    parser = { registerOscHandler: vi.fn() };
    buffer = { active: { baseY: 0, getLine: () => undefined } };
    loadAddon = vi.fn();
    open = vi.fn(() => { this.cols = 120; this.rows = 40; });
    write = vi.fn();
    reset = vi.fn();
    scrollToBottom = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    focus = vi.fn();
    dispose = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    getSelection = vi.fn(() => "");
    refresh = vi.fn();
  }
  return { Terminal };
});
vi.mock("@xterm/addon-fit", () => {
  class FitAddon { fit = vi.fn(); }
  return { FitAddon };
});
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const ENABLED = !!process.env.BSC_LAUNCH_PARITY;
const HOME = homedir();
const BASE = join(HOME, ".base-studio-code");
/** The source tree the build under test was built from — what `debug_repo_root` answers there. The Rust
 *  verb derives the same fact from the tree IT was built in, so run both from one checkout (or set this). */
const APP_REPO = process.env.BSC_LAUNCH_PARITY_APP_REPO ?? process.cwd();
const APP_STATE = join(HOME, ".local/share/com.basestudio.code/app-state.json");
const OUT = process.env.BSC_LAUNCH_PARITY_OUT ?? join(tmpdir(), "bsc-launch-parity");
const RUST_BIN = process.env.BSC_LAUNCH_PARITY_BIN;
const ERRAND = "PARITY ERRAND";
/** The project and repo the triage pane is launched for — a real clone under the project's hub. */
const TRIAGE_PROJECT = process.env.BSC_LAUNCH_PARITY_TRIAGE_PROJECT ?? "studio-code";
const TRIAGE_REPO = process.env.BSC_LAUNCH_PARITY_TRIAGE_REPO ?? "kevinthelago/base-studio-code";

/** Every invoke the app made, in order — the capture this whole file exists for. */
const calls: Array<[string, Record<string, unknown> | undefined]> = [];
/** `bsc` calls that were NOT reads and so were swallowed rather than run. Reported, never executed. */
const suppressed: string[] = [];

/** The read verbs the hydration + launch path may run for real. Anything else could write a store. */
const READS: string[][] = [
  ["persona", "list"],
  ["persona", "get"],
  ["skill", "list"],
  ["skill", "group", "list"],
  ["surface", "list"],
  ["surface", "drill"],
  ["plan", "fleet", "get"],
  ["plan", "classify", "get"],
  ["request", "list"],
];
const isRead = (args: string[]) => READS.some((r) => r.every((w, i) => args[i] === w));

/** Run the real `bsc`, wired the way `wire_bsc_stores` wires it for a project key. */
function runBsc(projectKey: string | null, args: string[], stdin?: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, BSC_SKILL_DB: join(BASE, "skills.db") };
  delete env.BSC_PLAN_DB;
  if (projectKey) env.BSC_PLAN_DB = join(BASE, "plans", `${projectKey}.db`);
  const r = spawnSync(RUST_BIN ?? "bsc", args, { env, input: stdin, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`bsc ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** The config dir as `get_config_files` exports it: every readable file, keyed by posix relpath. */
function configFiles(): Record<string, string> {
  const root = join(BASE, "config");
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        try { out[p.slice(root.length + 1)] = readFileSync(p, "utf8"); } catch { /* unreadable ⇒ absent, as in Rust */ }
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** The persisted store, unwrapped from its double encoding (`{"app-state": "<json string>"}`). */
function persisted(): Record<string, unknown> {
  const outer = JSON.parse(readFileSync(APP_STATE, "utf8")) as Record<string, string>;
  const inner = JSON.parse(outer["app-state"]) as Record<string, unknown>;
  return (inner.state ?? inner) as Record<string, unknown>;
}

/** A present secret becomes a sentinel naming it; an absent one stays empty. */
const sentinel = (name: string, v: unknown) => (typeof v === "string" && v.trim() ? `<secret:${name}>` : "");

/** Probed in `beforeAll`, never at import: a skipped suite must not spawn anything. */
let bwrapOk = false;

/** Drop null/undefined recursively, so "absent" and "null" compare equal in the diff — and order every
 *  object's keys, since a JSON object has no order and the two sides build theirs differently (a generated
 *  profile is an object literal on one side and a sorted map on the other). */
function norm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== null && x !== undefined) o[k] = norm(x);
    }
    return o;
  }
  return v;
}

/** A capability compared by what the backend READS of it — the `RoleCapability` fields, with the
 *  renderer's absent lists as empty. The renderer also sends inert persona keys (`mode`, `tools`,
 *  `denyGlobs`, `netAllow`) that the backend's deserializer drops; they are not a difference. */
function capability(v: unknown): unknown {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  return {
    role: c.role, github: c.github, git: c.git, code: c.code, net: c.net, ui: c.ui, graph: c.graph,
    writeGlobs: c.writeGlobs ?? [], allow: c.allow ?? [], surfaces: c.surfaces ?? null, harvestRoots: c.harvestRoots ?? [],
  };
}

/** The renderer carries a credential in `env` (as a sentinel here); the Rust plan NAMES it in `secretEnv`
 *  and leaves it out of `env`. Move the renderer's into the same shape so the two compare. */
const SECRET_VARS = ["GH_TOKEN", "BSC_AGENT_API_KEY"];
function comparable(section: Record<string, unknown> | null, secretEnv?: Array<{ var: string }>) {
  if (!section) return section;
  const out: Record<string, unknown> = { ...section, roleCapability: capability(section.roleCapability) };
  if (section.env && typeof section.env === "object") {
    const env = { ...(section.env as Record<string, string>) };
    const carried = SECRET_VARS.filter((k) => k in env);
    for (const k of carried) delete env[k];
    // A MAP, compared as one: the renderer builds it in insertion order and the plan serializes it sorted,
    // and `JSON.stringify` would report that as a difference in every pane.
    const sorted = Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
    out.env = Object.keys(sorted).length ? sorted : undefined;
    out.secretVars = carried.sort();
  } else if (secretEnv) {
    out.secretVars = [];
  }
  if (secretEnv) out.secretVars = secretEnv.map((s) => s.var).sort();
  return out;
}

function diffSection(label: string, ts: unknown, rust: unknown): string[] {
  const a = (norm(ts) ?? {}) as Record<string, unknown>;
  const b = (norm(rust) ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const sa = JSON.stringify(a[k]);
    const sb = JSON.stringify(b[k]);
    if (sa === sb) lines.push(`  = ${label}.${k}`);
    else lines.push(`  ≠ ${label}.${k}\n      ts:   ${sa ?? "<absent>"}\n      rust: ${sb ?? "<absent>"}`);
  }
  return lines;
}

let TerminalView: typeof TerminalViewType;
let store: typeof import("@/store");
let studio: typeof import("@/features/studio-sessions");
let debug: typeof import("@/features/debug");
let spawn: typeof import("@/features/glance/lib/surfaceSpawn");
let models: typeof import("@/app/console/lib/models");
let debugRequest: { id: number; origin: string | null; display_title: string | null } | null = null;

/** Mount the real TerminalView for one pane and return what its launch sent. */
async function capture(
  paneId: string,
  props: { initialCwd?: string; initCmd?: string; startupPrompt?: string },
  variant = "",
): Promise<void> {
  calls.length = 0;
  render(<TerminalView paneId={paneId} visible focused {...props} />);
  await waitFor(
    () => expect(calls.some(([c, a]) => c === "pty_create" && a?.paneId === paneId)).toBe(true),
    { timeout: 60_000, interval: 50 },
  );
  const pty = [...calls].reverse().find(([c, a]) => c === "pty_create" && a?.paneId === paneId)![1]!;
  const settings = [...calls].reverse().find(([c]) => c === "ensure_session_settings")?.[1] ?? null;
  const { cols: _cols, rows: _rows, ...ptyCreate } = pty;
  void _cols; void _rows;
  const name = `${paneId.replace(/[:/]/g, "__")}${variant ? `.${variant}` : ""}`;
  mkdirSync(OUT, { recursive: true });
  const ts = { paneId, ptyCreate, sessionSettings: settings };
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(ts, null, 2));

  if (RUST_BIN) {
    const args = ["session", "launch-plan", paneId, "--json"];
    if (props.startupPrompt === ERRAND) {
      const f = join(mkdtempSync(join(tmpdir(), "bsc-parity-")), "errand.txt");
      writeFileSync(f, ERRAND);
      args.push("--errand-file", f);
    }
    // A manual console's directory and command are the user's own; the view hands them down, and so does this.
    if (paneId.startsWith("man:") && props.initialCwd) {
      args.push("--cwd", props.initialCwd);
      if (props.initCmd) args.push("--init-cmd", props.initCmd);
    }
    const r = spawnSync(RUST_BIN, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    let rust: Record<string, unknown> | null;
    try { rust = JSON.parse(r.stdout) as Record<string, unknown>; } catch { rust = null; }
    writeFileSync(
      join(OUT, `${name}.rust.json`),
      rust ? JSON.stringify(rust, null, 2) : JSON.stringify({ exit: r.status, stdout: r.stdout, stderr: r.stderr }, null, 2),
    );
    const secretEnv = (rust?.secretEnv ?? []) as Array<{ var: string }>;
    const report = rust
      ? [
          `${paneId}${variant ? ` (${variant})` : ""} — ts vs rust`,
          ...diffSection(
            "ptyCreate",
            comparable(ts.ptyCreate as Record<string, unknown>),
            comparable(rust.ptyCreate as Record<string, unknown>, secretEnv),
          ),
          ...diffSection(
            "sessionSettings",
            comparable(ts.sessionSettings as Record<string, unknown> | null),
            comparable(rust.sessionSettings as Record<string, unknown> | null),
          ),
        ]
      : [`${paneId}: the Rust verb did not answer with JSON (exit ${r.status})`, (r.stderr || r.stdout).trim()];
    writeFileSync(join(OUT, `${name}.diff.txt`), report.join("\n") + "\n");
  }
  cleanup();
}

/** Seed a fleet the way `bsc fleet start` does: the plan store's fleet, launched twice so it is a RE-RUN. */
function startFleet(projectKey: string) {
  const fleet = JSON.parse(runBsc(projectKey, ["plan", "fleet", "get", "--full"]));
  const hubPath = join(BASE, "projects", projectKey);
  store.useAppStore.getState().fleetStartProject(projectKey, fleet, projectKey, { hubPath });
  store.useAppStore.getState().fleetStartProject(projectKey, fleet, projectKey, { hubPath });
}

describe.skipIf(!ENABLED)("launch-plan parity — what the frontend sends today (live, opt-in)", () => {
  beforeAll(async () => {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
    bwrapOk = spawnSync("bwrap", ["--version"]).status === 0;

    const files = configFiles();
    vi.mocked(invoke).mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      switch (cmd) {
        case "get_config_files": return files;
        case "bsc": {
          const a = (args?.args ?? []) as string[];
          if (!isRead(a) || args?.stdin !== undefined) {
            suppressed.push(a.join(" "));
            return "";
          }
          return runBsc((args?.projectKey as string | null) ?? null, a);
        }
        case "sandbox_available": return bwrapOk;
        case "read_document": {
          const p = join(BASE, String(args?.relpath ?? ""));
          if (!existsSync(p)) throw new Error(`no document at ${p}`);
          return readFileSync(p, "utf8");
        }
        case "preflight": return [];
        case "debug_repo_root": return APP_REPO;
        case "pty_create": return true;
        default: return null;
      }
    }) as never);

    const overrides = await import("@/shared/lib/core/configOverrides");
    await overrides.primeConfigOverrides();

    ({ TerminalView } = await import("@/app/console/panes/views/TerminalView"));
    store = await import("@/store");
    studio = await import("@/features/studio-sessions");
    debug = await import("@/features/debug");
    spawn = await import("@/features/glance/lib/surfaceSpawn");
    models = await import("@/app/console/lib/models");

    const st = store.useAppStore.getState();
    await st.hydratePersonas();
    await st.hydrateSkills();
    st.setSurfaceCatalog(JSON.parse(runBsc(null, ["surface", "list", "--json"])));

    const p = persisted();
    const repoTokens = Object.fromEntries(
      Object.entries((p.repoGithubTokens ?? {}) as Record<string, unknown>)
        .map(([repo, v]) => [repo, sentinel(`repoGithubTokens:${repo}`, v)])
        .filter(([, v]) => v),
    );
    const pick = (k: string) => (k in p ? { [k]: p[k] } : {});
    store.useAppStore.setState({
      ...pick("bypassPermissions"), ...pick("deniedCommands"), ...pick("autoResumeClaude"),
      ...pick("fleetHarness"), ...pick("llmProvider"), ...pick("llmModel"), ...pick("localBaseUrl"),
      ...pick("llmNumCtx"), ...pick("defaultModel"), ...pick("sandboxConsoles"), ...pick("agentProfiles"),
      ...pick("mcpServers"), ...pick("planClassification"), ...pick("projectBlueprintId"),
      ...pick("restrictToBscIssues"), ...pick("repoTriagePromptDoc"), ...pick("planFleet"),
      // The user's own per-pane choices. The resolver reads the same persisted maps over its derivation, so
      // the renderer's side has to start from them too or every pane a user ever touched reads as a diff.
      ...pick("paneProviders"), ...pick("paneModels"), ...pick("paneProfiles"), ...pick("panePersonas"),
      ...pick("sessionSkillOverrides"), ...pick("sessionSkillGroups"), ...pick("paneWasClaude"),
      githubToken: sentinel("githubToken", p.githubToken),
      repoGithubTokens: repoTokens,
      claudeApiKey: sentinel("claudeApiKey", p.claudeApiKey),
      openaiKey: sentinel("openaiKey", p.openaiKey),
      geminiKey: sentinel("geminiKey", p.geminiKey),
      bscBaseDir: BASE,
      appRepoRoot: APP_REPO,
    } as never);

    const rows = JSON.parse(runBsc(null, ["request", "list", "--json"])) as Array<{
      id: number; status: string; origin?: string | null; display_title?: string | null;
    }>;
    const pickRow = rows.find((r) => r.status === "claimed") ?? rows.find((r) => r.status === "open") ?? rows[0];
    if (pickRow) debugRequest = { id: pickRow.id, origin: pickRow.origin ?? null, display_title: pickRow.display_title ?? null };

    for (const key of ["studio-code", "radio", "cli-typer"]) startFleet(key);
  }, 300_000);

  afterEach(() => cleanup());

  /** A fleet pane is launched by the host from what the fleet start wired — cwd and command from the store, no prop. */
  const fleetPane = (paneId: string) => async () => {
    const st = store.useAppStore.getState();
    await capture(paneId, { initialCwd: st.paneCwds[paneId], initCmd: st.paneInitCmds[paneId] });
  };

  /** A surface session, seeded exactly as Glance's `openSurfaceSession` seeds it before the slot mounts:
   *  the crate's drill, the persona's prompt and model, the operator's generated profile — then the slot
   *  passes the joined cwd and the charter, and no command. */
  const surfacePane = (nodeId: string) => async () => {
    const noun = nodeId.split(":")[1];
    const catalog = JSON.parse(runBsc(null, ["surface", "list", "--json"])) as Array<{ name: string; crate: string }>;
    const crate = catalog.find((r) => r.name === noun)?.crate;
    expect(crate, `the catalog serves \`bsc ${noun}\``).toBeTruthy();
    const doc = JSON.parse(runBsc(null, ["surface", "drill", crate!, "--json"]));
    const paneId = spawn.surfacePaneIdForNode(nodeId)!;
    const assignment = spawn.surfaceAssignment(nodeId, doc)!;
    const personaId = assignment.kind === "operator" ? "persona-surface-operator" : "persona-surface-maintainer";
    const persona = JSON.parse(runBsc(null, ["persona", "get", personaId])) as { startPrompt: string; model?: string | null };
    const st = store.useAppStore.getState();
    if (persona.model) {
      st.setPaneModel(paneId, persona.model);
      const provider = models.providerForModel(persona.model);
      if (provider) st.setPaneProvider(paneId, provider);
    }
    if (assignment.kind === "operator") {
      const profile = spawn.surfaceOperatorProfile(assignment.noun);
      st.setAgentProfiles([...st.agentProfiles.filter((x) => x.id !== profile.id), profile]);
      st.setPaneProfile(paneId, spawn.surfaceOperatorProfileId(assignment.noun));
    }
    await capture(paneId, {
      initialCwd: `${APP_REPO}/${assignment.path}`,
      startupPrompt: spawn.surfaceCharter(assignment, persona.startPrompt, doc),
    });
  };

  it("director — studio-code:director", fleetPane("studio-code:director"), 120_000);
  it("worker (persona stream) — radio:radio", fleetPane("radio:radio"), 120_000);
  it("worker (plain, persona-less, owns globs) — cli-typer:app-shell", fleetPane("cli-typer:app-shell"), 120_000);

  it("studio — design-studio:designer-react, no errand", async () => {
    const def = studio.studioSessionDef("designerReact")!;
    const errand = studio.seedStudioLaunchState(def);
    const st = store.useAppStore.getState();
    await capture(def.paneId, {
      initialCwd: join(BASE, "design-studio", "react"),
      initCmd: studio.studioInitCmd(store.paneHarness(st, def.paneId)),
      startupPrompt: errand,
    });
  }, 120_000);

  it("studio — design-studio:designer-react, WITH an errand prop", async () => {
    const def = studio.studioSessionDef("designerReact")!;
    studio.seedStudioLaunchState(def);
    const st = store.useAppStore.getState();
    await capture(def.paneId, {
      initialCwd: join(BASE, "design-studio", "react"),
      initCmd: studio.studioInitCmd(store.paneHarness(st, def.paneId)),
      startupPrompt: ERRAND,
    }, "errand");
  }, 120_000);

  it("debug request — debug-studio:req-<n>", async () => {
    expect(debugRequest, "requests.db holds at least one row").not.toBeNull();
    const req = debugRequest!;
    const paneId = debug.requestPaneId(req.id);
    const charter = debug.requestCharter(req);
    // Exactly what RequestSessionsMount seeds before it renders the slot.
    store.useAppStore.setState((st) => ({
      paneStartupPromptText: { ...st.paneStartupPromptText, [paneId]: charter },
      paneContinue: { ...st.paneContinue, [paneId]: false },
    }));
    await capture(paneId, { initialCwd: APP_REPO, initCmd: debug.DEBUG_INIT_CMD, startupPrompt: charter });
  }, 120_000);

  it("network architect — network-finance:architect", async () => {
    const paneId = "network-finance:architect";
    studio.seedStudioLaunchState({ paneId, role: "architect", personaId: "persona-architect", defaultSkillIds: [] });
    const st = store.useAppStore.getState();
    await capture(paneId, {
      initialCwd: join(BASE, "networks", "finance"),
      initCmd: studio.studioInitCmd(store.paneHarness(st, paneId)),
    });
  }, 120_000);

  it(`triage — ${TRIAGE_PROJECT}:${TRIAGE_REPO}:triage`, async () => {
    // Exactly what AppBanners hands `triageStartProject`: the key as both name and id, and the Rust-resolved clone.
    const clone = join(BASE, "projects", TRIAGE_PROJECT, TRIAGE_REPO.split("/").pop()!);
    store.useAppStore.getState().triageStartProject(TRIAGE_PROJECT, [TRIAGE_REPO], TRIAGE_PROJECT, undefined, { [TRIAGE_REPO]: clone });
    await fleetPane(`${TRIAGE_PROJECT}:${TRIAGE_REPO}:triage`)();
  }, 120_000);

  it("manual console — man:parity-tab:p0", async () => {
    // The Console page's "+" pane: the user's own directory and command, handed down by the slot.
    await capture("man:parity-tab:p0", { initialCwd: APP_REPO, initCmd: "claude" });
  }, 120_000);

  it("surface operator — surface-studio:noun-session", surfacePane("noun:session"), 120_000);
  it("surface maintainer — surface-studio:verb-session-ask", surfacePane("verb:session:ask"), 120_000);
  it("surface maintainer, a hyphenated verb — surface-studio:verb-session-launch-plan", surfacePane("verb:session:launch-plan"), 120_000);

  it("never ran a store write", () => {
    // Swallowed writes are expected (hydration reconciles built-ins); the point is that none RAN.
    writeFileSync(join(OUT, "suppressed-bsc-writes.txt"), suppressed.join("\n") + "\n");
    expect(suppressed.every((s) => !isRead(s.split(" ")))).toBe(true);
  });
});
