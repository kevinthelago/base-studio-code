// The navigate CONTRACT lives in five places, and a field missing from any one of them is SILENT
// (`the-shared-navigation-mechanism-drill-select-and-show`): serde drops a field the Tauri ack does not
// declare, a TypeScript field Rust never names is always undefined, a request field `is_read_only` forgets
// slips past the presence gate, and a result field `lean` never prints is invisible to every shell reader.
// `declined` reached no caller for as long as it existed for exactly this reason.
//
// The five places are RECORDS, not files, so this reads them from the COMMITTED store — the copy the build
// compiles — and fails naming the field and the place that lacks it.
import { describe, it, expect } from "vitest";
import { loadImplementations, loadStore, resolveComponentStorePath } from "@scripts/lib/recordStore.mjs";
import { WORKSPACES } from "@/app/registry";

const LIB = "bsc-navigate--lib.rs";
const CLI = "bsc-navigate--cli.rs";
const TAURI = "src-tauri--navigate--mod.rs";
const BRIDGE = "navigate-bridge.ts";

/** Request fields that do not CHANGE the view, so `is_read_only` must not name them: `force` is a
 *  permission, `targets` asks for more in the reply, and `window` says WHICH window is being read or
 *  steered — a read of one window is still a read. */
const READ_FLAGS = new Set(["force", "targets", "window"]);
/** TypeScript ack keys that are the frontend's own bookkeeping, stripped before the ack is sent. */
const INTERNAL = new Set(["id", "error", "retryAfterHydrate", "awaitMount", "steerBlocked"]);

const records = new Map(
  ((loadImplementations() ?? []) as { id?: string; code?: string }[]).map((r) => [r.id, r.code ?? ""]),
);

function code(id: string): string {
  const src = records.get(id);
  if (!src) throw new Error(`record ${id} is not in the committed store`);
  return src;
}

/** The text from `start` up to (not including) the first `end` after it. */
function between(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`'${start}' not found`);
  const j = src.indexOf(end, i);
  return src.slice(i, j < 0 ? undefined : j);
}

/** The `pub` field names of a Rust struct. */
function rustFields(src: string, name: string): string[] {
  return [...between(src, `pub struct ${name} {`, "\n}\n").matchAll(/^\s*pub (\w+):/gm)].map((m) => m[1]);
}

/** The keys of an exported TypeScript interface. */
function tsKeys(src: string, name: string): string[] {
  return [...between(src, `export interface ${name} {`, "\n}\n").matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
}

const camel = (s: string) => s.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

describe("the navigate contract holds in all five places", () => {
  const request = rustFields(code(LIB), "NavRequest");
  const result = rustFields(code(LIB), "NavResult");

  it("reads a real population, so a parser that stopped matching fails instead of passing empty", () => {
    expect(request).toEqual(expect.arrayContaining(["force", "workspace", "drill", "select", "targets"]));
    expect(result).toEqual(expect.arrayContaining(["workspace", "declined", "drill", "selection", "targets_total"]));
  });

  it("the TypeScript request names exactly the Rust request's fields", () => {
    const ts = tsKeys(code(BRIDGE), "NavRequest");
    expect({ missing: request.map(camel).filter((f) => !ts.includes(f)), extra: ts.filter((f) => !request.map(camel).includes(f)) })
      .toEqual({ missing: [], extra: [] });
  });

  it("every request field that changes the view makes is_read_only false", () => {
    const body = between(code(LIB), "pub fn is_read_only", "\n    }\n");
    expect(request.filter((f) => !READ_FLAGS.has(f) && !body.includes(`self.${f}`))).toEqual([]);
  });

  it("the CLI builds every request field", () => {
    const body = between(code(CLI), "fn plan(", "\n}\n");
    // As a struct-literal FIELD (`drill: Some(…)`, `force,`), not merely as a word: the usage strings say
    // `bsc app go drill <path>`, and a bare word match would pass with the field never set.
    expect(request.filter((f) => !new RegExp(`\\b${f}\\b\\s*[:,}]`).test(body))).toEqual([]);
  });

  it("the Tauri ack declares every result field and maps each one through", () => {
    const ack = rustFields(code(TAURI), "NavAck");
    expect(result.filter((f) => !ack.includes(f))).toEqual([]);
    const apply = between(code(TAURI), "pub fn apply(", "\n}\n");
    expect(result.filter((f) => !apply.includes(`ack.${f}`))).toEqual([]);
  });

  it("the TypeScript ack sends every result field, and nothing Rust would drop", () => {
    const ts = tsKeys(code(BRIDGE), "NavAck").filter((k) => !INTERNAL.has(k));
    const wire = result.map(camel);
    expect({ missing: wire.filter((f) => !ts.includes(f)), extra: ts.filter((f) => !wire.includes(f)) })
      .toEqual({ missing: [], extra: [] });
  });

  it("the lean line prints every result field", () => {
    const body = between(code(CLI), "fn lean(", "\n}\n");
    expect(result.filter((f) => !body.includes(`r.${f}`))).toEqual([]);
  });

  // ── ONE REQUEST, ONE WINDOW (`the-agent-view-is-a-window-a-session-navigates-without-moving-yours`) ──
  //
  // Both halves are needed and neither is visible in a render: Rust must emit to the window the request
  // NAMED, and the bridge must subscribe on ITS OWN window. `listen()` from the api root registers the
  // target `Any`, which hears an emit aimed at somebody else — so a broadcast, or a global listener, and
  // the agent view answers for the user's window (or the reverse). The ack registry delivers the FIRST
  // answer, so the wrong window wins silently and the caller photographs the wrong screen.
  it("Rust delivers a navigate to ONE window, not every window", () => {
    const apply = between(code(TAURI), "pub fn apply(", "\n}\n");
    expect(apply, "the request's window is what it is delivered to").toContain("emit_to(label");
    expect(apply.includes("app.emit("), "a broadcast reaches every window's bridge").toBe(false);
    // And the window is ensured before the emit, so `bsc app view` opens the view on first use.
    expect(apply).toContain("agent_window::ensure(app, label)");
  });

  it("the bridge subscribes on its OWN window", () => {
    const bridge = code("use-navigate-bridge.ts");
    expect(bridge).toContain('getCurrentWebviewWindow().listen<NavRequest & { id: string }>("bsc://navigate"');
    expect(
      /^\s*const un = listen</m.test(bridge),
      "a root-level listen() registers the target Any and hears another window's request",
    ).toBe(false);
  });

  it("the workspace help names the current rail", () => {
    const doc = between(code(CLI), 'name: "workspace"', "},");
    expect(WORKSPACES.map((w) => w.key).filter((k) => !new RegExp(`\\b${k}\\b`).test(doc))).toEqual([]);
  });
});

/**
 * A TABBED workspace that is absent from the page maps is SILENT IN BOTH DIRECTIONS, and that is the
 * whole reason this exists.
 *
 * Being absent is CORRECT while a workspace has no pages — Credentials was legitimately missing from
 * every map below for as long as its screen was a single untabbed list. The moment it gained tabs the
 * same absence became three bugs, none of which fails a build:
 *
 *   · `WORKSPACE_PAGE` (navigate.ts) — `bsc navigate --workspace X --page p` switches the workspace,
 *     drops the page, and ACKS. The verb reports success while landing on whatever was last open.
 *   · `PAGES` (locationCrumb) — the titlebar reads just "X" whichever tab is open.
 *   · `DEFAULT_PAGE` (locationCrumb) — the crumb names no page until the user's first click, which
 *     reads as the crumb simply not covering that screen.
 *
 * `usePageTabs("<key>", …)` is the observable signal that a workspace is tabbed: it is what publishes
 * the tab set the navigate bridge validates against, so a screen that calls it is addressable by page
 * and a screen that does not is not. Keying on it means the NEXT tabbed workspace is caught here
 * rather than by someone noticing the verb is quietly useless.
 *
 * BOTH RECORD STORES ARE READ. A workspace screen may be an algorithms record (Credentials, Jobs,
 * Memory) or a COMPONENT record (Glance, Logs, Teams, Algorithms, Data, Sounds, Console, and the
 * Components workspace itself, whose record is `guidecard`), and the two stores keep their source in
 * different fields — `code` against `srcText`. Reading only the algorithms store finds 3 of 11 and
 * every assertion below passes over the other 8.
 */
describe("every tabbed workspace is reachable by page", () => {
  const WORKSPACE_KEYS: ReadonlySet<string> = new Set<string>(WORKSPACES.map((w) => w.key));

  /** Workspace keys passed to `usePageTabs` anywhere in either store. */
  const tabbed = (() => {
    const found = new Set<string>();
    const scan = (text: string) => {
      for (const m of text.matchAll(/usePageTabs\(\s*["'`]([a-z0-9-]+)["'`]/g)) {
        // Only WORKSPACE keys. `usePageTabs` also drives strips that are not rail destinations —
        // the Settings sections (mcp, skills, automations) are pages WITHIN Settings, and they have
        // no workspace page of their own to register.
        if (WORKSPACE_KEYS.has(m[1])) found.add(m[1]);
      }
    };
    for (const src of records.values()) scan(src);
    // `resolveComponentStorePath` can answer null (no store on this checkout). Throwing names the
    // real cause; silently scanning nothing would make 8 of the 11 unchecked and still pass.
    const compStore = resolveComponentStorePath(".");
    if (!compStore) throw new Error("the component record store is not resolvable — 8 of 11 workspaces live there");
    for (const rec of (loadStore(compStore).implementations ?? []) as Record<string, unknown>[]) {
      // Every string field, rather than a named one: a component record carries its source in
      // `srcText` while an algorithms record uses `code`, and naming the field is how this check
      // would silently cover one store.
      for (const v of Object.values(rec)) if (typeof v === "string") scan(v);
    }
    return found;
  })();

  /**
   * The console is tabbed, and deliberately absent from `WORKSPACE_PAGE`: its "pages" are INDEXED
   * tabs switched by `setActiveTab(idx)`, not a string page, so a navigate to console carries no
   * page at all. Exempting it by name keeps that decision visible instead of looking like a gap.
   */
  const NO_STRING_PAGE = new Set(["console"]);

  /**
   * Workspaces whose tabs are DATA, not a constant: the technologies the kits carry, the teams in the
   * store, the languages present, the sound kits. The crumb Title-Cases those ids rather than keeping
   * a curated label map, because a curated map would go stale the moment the data changed and a stale
   * label shows the WRONG name rather than an ugly one. They own no fixed first tab either, so they
   * owe neither crumb entry. A workspace whose tab set is a CONSTANT owes both.
   */
  const DATA_TABBED = new Set(["components", "teams", "algorithms", "data", "sounds", "lan"]);

  it("finds a real population across BOTH stores, so a changed call shape fails instead of passing empty", () => {
    // Without this, the regex going stale makes every assertion below vacuous — the failure mode of
    // every source-asserting guard in this repo. 11 are tabbed today.
    expect([...tabbed].sort().join(","), "scanned both stores").toContain("credentials");
    expect(tabbed.size, `only found ${[...tabbed].sort().join(", ")}`).toBeGreaterThan(8);
  });

  it("registers each one in WORKSPACE_PAGE, so `navigate --page` reaches a tab", () => {
    const map = between(code("navigate.ts"), "const WORKSPACE_PAGE", "const WORKSPACE_DRILL");
    const owed = [...tabbed].filter((k) => !NO_STRING_PAGE.has(k));
    expect(owed.length).toBeGreaterThan(8);
    expect(
      owed.filter((k) => !new RegExp(`^\\s*${k}:`, "m").test(map)).sort(),
      "tabbed, but `navigate --page` silently drops the page and acks anyway",
    ).toEqual([]);
  });

  it("labels each fixed-tab one's pages in the crumb, and gives it a default page", () => {
    const crumb = code("location-crumb.ts");
    const pages = between(crumb, "const PAGES", "const GRAPH_CRUMB_KEY");
    const defaults = between(crumb, "const DEFAULT_PAGE", "const label =");
    const owed = [...tabbed].filter((k) => !DATA_TABBED.has(k) && !NO_STRING_PAGE.has(k));
    expect(owed.length, `fixed-tab workspaces: ${owed.join(", ")}`).toBeGreaterThan(2);
    expect(
      owed.filter((k) => !new RegExp(`^\\s*${k}:`, "m").test(pages)).sort(),
      "tabbed with a fixed tab set, but the crumb has no labels for its pages",
    ).toEqual([]);
    expect(
      owed.filter((k) => !new RegExp(`\\b${k}:`).test(defaults)).sort(),
      "tabbed with a fixed tab set, but the crumb names no page until the first click",
    ).toEqual([]);
  });
});
