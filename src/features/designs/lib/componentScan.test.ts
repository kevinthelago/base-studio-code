import { describe, it, expect, vi } from "vitest";
import {
  buildSignature, scannableComponents, pendingScans, runPooled, toBuildStatus, buildAndProbe, scanComponents, durableLogSync,
  probeStateBlanks,
  type ScannableComponent, type ComponentBuildStatus, type RunFn, type StateProbe, type RuntimeStateCategory,
} from "./componentScan";
import type { KitArtifact } from "./componentPreview";
import type { ComponentRecord } from "./model";

// The esbuild-wasm bundle + the DOM runtime probe can't run under jsdom, so these cover the PURE spine of
// the on-visit scan (#2838, #2908): which components to scan, the throttle/queue pool, and the
// build→run→status derivation — with a MOCK bundle + MOCK run (plain fns that resolve or throw). The real
// esbuild bundle + iframe probe are exercised in the running app.

/** A run step that passes everything (build-clean ⇒ ok) — the default when a test only exercises builds. */
const runOk: RunFn = async () => ({ ok: true });

const base: ComponentRecord = {
  id: "card", name: "Card", kitId: "react-ui", role: "primitive", version: "1.0.0", used: 0,
  tags: [], variants: ["default"], composes: [], props: [], whenUse: [], whenNot: [],
  src: "shared/ui/data/Card.tsx", srcText: "",
};

const ARTIFACT: KitArtifact = {
  components: [
    { id: "card", src: "shared/ui/data/Card.tsx", source: "export function Card() { return null; }" },
  ],
  runtime: {},
};

const sc = (id: string, sig = id): ScannableComponent => ({ id, sig, files: { entry: id }, entry: "entry" });

describe("buildSignature", () => {
  it("changes when any buildable-source field changes (so an edit re-queues just that component)", () => {
    const a = buildSignature(base);
    expect(buildSignature(base)).toBe(a); // stable for the same record
    expect(buildSignature({ ...base, source: "export const X = 1;" })).not.toBe(a);
    expect(buildSignature({ ...base, srcText: "import * as d3 from 'd3'; export const X = 1;" })).not.toBe(a);
    expect(buildSignature({ ...base, src: "other/Path.tsx" })).not.toBe(a);
  });
});

describe("scannableComponents", () => {
  it("keeps only components with buildable preview source (excludes the no-implementation stubs)", () => {
    const buildable = base; // built-in with artifact source → buildable
    const stub: ComponentRecord = { ...base, id: "ghost", name: "Ghost", src: "nowhere/Ghost.tsx" }; // no artifact source, no module srcText
    const out = scannableComponents([buildable, stub], ARTIFACT);
    expect(out.map((s) => s.id)).toEqual(["card"]); // the stub is NOT a build FAILURE — it's excluded here
    expect(out[0].sig).toBe(buildSignature(buildable)); // no collection/loading prop ⇒ sig unchanged by #3191
    expect(out[0].entry).toBeTruthy();
    expect(out[0].states).toBeUndefined(); // a propless built-in has no data-state to render-probe
  });

  it("excludes app-graph records (base-studio-code kit) — they preview live, not through this esbuild path (#3859)", () => {
    const appPage: ComponentRecord = {
      ...base, id: "mcppage", name: "McpWorkspace", kitId: "base-studio-code", role: "page",
      src: "src/features/mcp/McpWorkspace.tsx", source: undefined,
      srcText: 'import { useAppStore } from "@/store";\nexport function McpWorkspace(){ return null; }',
    };
    const out = scannableComponents([base, appPage], ARTIFACT);
    expect(out.map((s) => s.id)).toEqual(["card"]); // the app-graph record never reaches the scan
  });

  it("adds an empty-state probe for a data (collection) component and a loading-state probe for a loading one (#3191)", () => {
    const dataComp: ComponentRecord = {
      ...base, id: "chart", name: "Chart", src: "user/Chart.tsx",
      source: "export function Chart({ rows }){ return <ul>{rows.map((r) => <li key={r}/>)}</ul>; }",
      props: [{ name: "rows", type: "Row[]", req: false, desc: "" }],
    };
    const loadingComp: ComponentRecord = {
      ...base, id: "panel", name: "Panel", src: "user/Panel.tsx",
      source: "export function Panel({ loading }){ return loading ? null : <div>ok</div>; }",
      props: [{ name: "loading", type: "boolean", req: false, desc: "" }],
    };
    const button: ComponentRecord = {
      ...base, id: "btn", name: "Button", src: "user/Button.tsx",
      source: "export function Button({ label }){ return <button>{label}</button>; }",
      props: [{ name: "label", type: "string", req: false, desc: "" }],
    };
    const byId = new Map(scannableComponents([dataComp, loadingComp, button], ARTIFACT).map((s) => [s.id, s]));
    expect(byId.get("chart")?.states?.map((s) => s.category)).toEqual(["empty-empty-state"]);
    expect(byId.get("panel")?.states?.map((s) => s.category)).toEqual(["empty-loading-state"]);
    expect(byId.get("btn")?.states).toBeUndefined(); // no collection/loading prop → never state-probed
    // The state build reuses the same file set, only the sampled props differ, so it's a real bundle input.
    expect(byId.get("chart")?.states?.[0].files).toBeTruthy();
    expect(byId.get("chart")?.states?.[0].entry).toBeTruthy();
  });
});

describe("pendingScans", () => {
  it("re-queues only components whose signature changed (or were never scanned)", () => {
    const items = [sc("a", "a1"), sc("b", "b1"), sc("c", "c1")];
    const prev = new Map([["a", "a1"], ["b", "b0"]]); // a unchanged, b changed, c never scanned
    expect(pendingScans(items, prev).map((s) => s.id)).toEqual(["b", "c"]);
    // Nothing pending once every current signature is recorded.
    const all = new Map(items.map((s) => [s.id, s.sig]));
    expect(pendingScans(items, all)).toEqual([]);
  });
});

describe("runPooled — throttle/queue", () => {
  it("processes every item exactly once", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const seen: number[] = [];
    await runPooled(items, 3, async (n) => { seen.push(n); });
    expect(seen.sort((x, y) => x - y)).toEqual(items);
  });

  it("never runs more than `concurrency` workers at once", async () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;
    await runPooled(items, 4, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 0)); // yield so the pool overlaps
      inFlight--;
    });
    expect(maxInFlight).toBe(4); // exactly the pool size when there are more items than slots
  });

  it("caps the pool at the item count when there are fewer items than the concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await runPooled([1, 2], 5, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 0));
      inFlight--;
    });
    expect(maxInFlight).toBe(2);
  });

  it("handles an empty list without spawning work", async () => {
    const worker = vi.fn();
    await runPooled([], 3, worker);
    expect(worker).not.toHaveBeenCalled();
  });
});

describe("toBuildStatus — ok/error derivation", () => {
  it("maps a null/undefined outcome to ok and anything else to a build error with a message", () => {
    expect(toBuildStatus(null)).toEqual({ state: "ok" });
    expect(toBuildStatus(undefined)).toEqual({ state: "ok" });
    expect(toBuildStatus(new Error("boom"))).toEqual({ state: "error", kind: "build", message: "boom" });
    expect(toBuildStatus("plain string failure")).toEqual({ state: "error", kind: "build", message: "plain string failure" });
  });
});

describe("buildAndProbe — build then runtime probe (#2908)", () => {
  const item = sc("x");

  it("builds clean and runs clean ⇒ ok", async () => {
    const bundle = vi.fn(async () => "/*js*/");
    const run = vi.fn(runOk);
    expect(await buildAndProbe(item, bundle, run)).toEqual({ state: "ok" });
    expect(run).toHaveBeenCalledWith("/*js*/"); // the built JS is handed to the probe
  });

  it("builds clean but throws at runtime ⇒ a RUNTIME error (the gap #2908 closes)", async () => {
    const bundle = vi.fn(async () => "/*js*/");
    const run: RunFn = async () => ({ ok: false, message: "links[0].source is undefined" });
    expect(await buildAndProbe(item, bundle, run)).toEqual({
      state: "error", kind: "runtime", message: "links[0].source is undefined",
    });
  });

  it("fails to build ⇒ a BUILD error, and the runtime probe is never run", async () => {
    const bundle = vi.fn(async () => { throw new Error("Transform failed"); });
    const run = vi.fn(runOk);
    expect(await buildAndProbe(item, bundle, run)).toEqual({ state: "error", kind: "build", message: "Transform failed" });
    expect(run).not.toHaveBeenCalled(); // no point running a module that didn't build
  });

  it("treats a probe-infrastructure failure as inconclusive ⇒ ok (never a false badge)", async () => {
    const bundle = vi.fn(async () => "/*js*/");
    const run: RunFn = async () => { throw new Error("iframe blew up"); };
    expect(await buildAndProbe(item, bundle, run)).toEqual({ state: "ok" });
  });

  it("builds + mounts clean but renders nothing ⇒ an EMPTY status (#2926)", async () => {
    const bundle = vi.fn(async () => "/*js*/");
    const run: RunFn = async () => ({ ok: true, empty: true });
    const status = await buildAndProbe(item, bundle, run);
    expect(status.state).toBe("empty");
    expect(status).toHaveProperty("message");
  });

  it("a clean render that produced output is ok, not empty (#2926)", async () => {
    const bundle = vi.fn(async () => "/*js*/");
    const run: RunFn = async () => ({ ok: true, empty: false });
    expect(await buildAndProbe(item, bundle, run)).toEqual({ state: "ok" });
  });
});

describe("scanComponents — build + runtime sweep with mock bundle/run", () => {
  it("records ok for builds that resolve and a build error(message) for builds that throw", async () => {
    const items = [sc("ok1"), sc("bad"), sc("ok2")];
    // Mock bundle: `bad` throws an esbuild-style error, the rest resolve.
    const bundle = vi.fn(async (files: Record<string, string>) => {
      if (files.entry === "bad") throw new Error("Transform failed: Unexpected }");
      return "/*bundle*/";
    });
    const results = new Map<string, ComponentBuildStatus>();
    await scanComponents(items, bundle, 2, (id, status) => results.set(id, status));

    expect(bundle).toHaveBeenCalledTimes(3); // every buildable component was attempted
    expect(results.get("ok1")).toEqual({ state: "ok" });
    expect(results.get("ok2")).toEqual({ state: "ok" });
    expect(results.get("bad")).toEqual({ state: "error", kind: "build", message: "Transform failed: Unexpected }" });
  });

  it("badges a build-clean component that throws at RUNTIME via the run step (#2908)", async () => {
    const items = [sc("ok"), sc("throws")];
    // Everything builds clean; the bundle echoes the component id (files.entry) so the probe can key off it.
    const bundle = vi.fn(async (files: Record<string, string>) => files.entry);
    // Runtime probe: the `throws` component fails at runtime, the rest run clean.
    const run: RunFn = async (js) => (js === "throws" ? { ok: false, message: "d3 tick threw" } : { ok: true });
    const results = new Map<string, ComponentBuildStatus>();
    await scanComponents(items, bundle, 2, (id, status) => results.set(id, status), () => false, run);

    expect(results.get("ok")).toEqual({ state: "ok" });
    expect(results.get("throws")).toEqual({ state: "error", kind: "runtime", message: "d3 tick threw" });
  });

  it("does not let one throwing build abort the rest of the sweep", async () => {
    const items = Array.from({ length: 6 }, (_, i) => sc(`c${i}`));
    const bundle = vi.fn(async () => { throw new Error("always fails"); });
    const results = new Map<string, ComponentBuildStatus>();
    await scanComponents(items, bundle, 3, (id, status) => results.set(id, status));
    expect(results.size).toBe(6); // all six reported despite every one throwing
    for (const s of results.values()) expect(s.state).toBe("error");
  });

  it("respects the concurrency cap while building", async () => {
    const items = Array.from({ length: 9 }, (_, i) => sc(`c${i}`));
    let inFlight = 0;
    let maxInFlight = 0;
    const bundle = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 0));
      inFlight--;
      return "";
    });
    await scanComponents(items, bundle, 3, () => {});
    expect(maxInFlight).toBe(3);
  });

  it("short-circuits when cancelled — no result is reported after the flag flips", async () => {
    const items = Array.from({ length: 5 }, (_, i) => sc(`c${i}`));
    const bundle = vi.fn(async () => "");
    const onResult = vi.fn();
    // Cancelled from the start → the pool runs but nothing is recorded.
    await scanComponents(items, bundle, 2, onResult, () => true);
    expect(onResult).not.toHaveBeenCalled();
  });
});

describe("probeStateBlanks — render-confirm data-state blanks (#3191)", () => {
  const state = (category: RuntimeStateCategory, entry: string): StateProbe => ({ category, files: { entry }, entry: "entry" });

  it("flags a state that renders BLANK (ok && empty) but not one that renders content", async () => {
    const bundle = vi.fn(async (files: Record<string, string>) => files.entry);
    // The empty-state build renders blank; the loading-state build renders content.
    const run: RunFn = async (js) => (js === "blank" ? { ok: true, empty: true } : { ok: true, empty: false });
    const states = [state("empty-empty-state", "blank"), state("empty-loading-state", "full")];
    expect(await probeStateBlanks(states, bundle, run)).toEqual(["empty-empty-state"]);
  });

  it("flags both categories when both states render blank", async () => {
    const bundle = vi.fn(async () => "js");
    const run: RunFn = async () => ({ ok: true, empty: true });
    const states = [state("empty-empty-state", "a"), state("empty-loading-state", "b")];
    expect(await probeStateBlanks(states, bundle, run)).toEqual(["empty-empty-state", "empty-loading-state"]);
  });

  it("does NOT flag a state that renders content — a real EmptyState / skeleton (the not-flagged side)", async () => {
    const bundle = vi.fn(async () => "js");
    const run: RunFn = async () => ({ ok: true, empty: false });
    expect(await probeStateBlanks([state("empty-empty-state", "js")], bundle, run)).toEqual([]);
  });

  it("skips a state whose build fails or whose probe throws (inconclusive ⇒ never a false flag)", async () => {
    const bundle = vi.fn(async (files: Record<string, string>) => {
      if (files.entry === "nobuild") throw new Error("Transform failed");
      return files.entry;
    });
    const run: RunFn = async (js) => {
      if (js === "probefail") throw new Error("iframe blew up");
      return { ok: true, empty: true };
    };
    const states = [state("empty-empty-state", "nobuild"), state("empty-loading-state", "probefail")];
    expect(await probeStateBlanks(states, bundle, run)).toEqual([]);
  });

  it("does not flag a state that THROWS at runtime (a throw is not a blank render)", async () => {
    const bundle = vi.fn(async () => "js");
    const run: RunFn = async () => ({ ok: false, message: "data.map is not a function" });
    expect(await probeStateBlanks([state("empty-empty-state", "js")], bundle, run)).toEqual([]);
  });
});

describe("scanComponents — data-state blank reporting (#3191)", () => {
  /** A scannable whose LOADED build echoes its id and that carries one state probe echoing `stateEntry`. */
  const withState = (id: string, category: RuntimeStateCategory, stateEntry: string): ScannableComponent => ({
    id, sig: id, files: { entry: id }, entry: "entry",
    states: [{ category, files: { entry: stateEntry }, entry: "entry" }],
  });

  it("reports the render-confirmed blank state of a component that renders fine loaded", async () => {
    const items = [withState("chart", "empty-empty-state", "emptyblank")];
    const bundle = vi.fn(async (files: Record<string, string>) => files.entry);
    // loaded ("chart") renders content; the empty-state build ("emptyblank") renders blank.
    const run: RunFn = async (js) => (js === "emptyblank" ? { ok: true, empty: true } : { ok: true, empty: false });
    const results = new Map<string, RuntimeStateCategory[]>();
    await scanComponents(items, bundle, 2, (id, _status, blanks) => results.set(id, blanks), () => false, run);
    expect(results.get("chart")).toEqual(["empty-empty-state"]);
  });

  it("reports NO blank when the component's empty state renders content (a real EmptyState message)", async () => {
    const items = [withState("good", "empty-empty-state", "emptyfull")];
    const bundle = vi.fn(async (files: Record<string, string>) => files.entry);
    const run: RunFn = async () => ({ ok: true, empty: false }); // every state renders content
    const results = new Map<string, RuntimeStateCategory[]>();
    await scanComponents(items, bundle, 2, (id, _s, b) => results.set(id, b), () => false, run);
    expect(results.get("good")).toEqual([]);
  });

  it("does NOT probe states when the LOADED render is itself blank (that's the #2926 signal, not a state fault)", async () => {
    const items = [withState("blankLoaded", "empty-empty-state", "emptyblank")];
    const bundle = vi.fn(async (files: Record<string, string>) => files.entry);
    const run: RunFn = async () => ({ ok: true, empty: true }); // loaded blank → status "empty"
    const results = new Map<string, RuntimeStateCategory[]>();
    const statuses = new Map<string, string>();
    await scanComponents(items, bundle, 2, (id, status, b) => { results.set(id, b); statuses.set(id, status.state); }, () => false, run);
    expect(statuses.get("blankLoaded")).toBe("empty");
    expect(results.get("blankLoaded")).toEqual([]);
    expect(bundle).toHaveBeenCalledTimes(1); // only the loaded build ran — the state build was skipped
  });

  it("reports [] for a stateless component (no states probed) — e.g. a Button", async () => {
    const items = [sc("button")]; // no `states`
    const bundle = vi.fn(async () => "js");
    const run: RunFn = async () => ({ ok: true, empty: false });
    const results = new Map<string, RuntimeStateCategory[]>();
    await scanComponents(items, bundle, 2, (id, _s, b) => results.set(id, b), () => false, run);
    expect(results.get("button")).toEqual([]);
  });
});

describe("durableLogSync — mirror render results to the durable log (#3540/#3549)", () => {
  it("records a runtime throw's message with a `render:` kind prefix", () => {
    expect(durableLogSync({ state: "ok" }, { state: "error", kind: "runtime", message: "reading map of undefined" }))
      .toBe("render: reading map of undefined");
    // ...even with no prior status (first-visit error).
    expect(durableLogSync(undefined, { state: "error", kind: "runtime", message: "boom" })).toBe("render: boom");
  });

  it("records a BUILD failure too, with a `build:` prefix (#3549 — not always statically detectable)", () => {
    // WorkspaceShellPage built clean by doctor's static analyzer yet esbuild rejected its TS (extensionless
    // src → jsx loader). The REAL build's failure must reach the log so `bsc ui doctor` surfaces it.
    expect(durableLogSync(undefined, { state: "error", kind: "build", message: "Build failed with 1 error" }))
      .toBe("build: Build failed with 1 error");
  });

  it("clears (empty) when a prior error is now ok or empty", () => {
    expect(durableLogSync({ state: "error", kind: "runtime", message: "x" }, { state: "ok" })).toBe("");
    expect(durableLogSync({ state: "error", kind: "build", message: "x" }, { state: "empty", message: "" })).toBe("");
  });

  it("does NOTHING for a healthy or (still) empty component — no first-visit log spam", () => {
    expect(durableLogSync(undefined, { state: "ok" })).toBeNull(); // first-visit ok
    expect(durableLogSync({ state: "ok" }, { state: "ok" })).toBeNull();
    // empty (rendered nothing but did not throw) with no prior error is a no-op too.
    expect(durableLogSync(undefined, { state: "empty", message: "" })).toBeNull();
  });
});
