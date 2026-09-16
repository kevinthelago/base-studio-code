// Algorithms graph harness (`the-algorithms-graph-drills-by-crate`) — mounts the REAL AlgorithmsWorkspace in
// real Chromium at the size of the live store, and measures what each LAYER costs.
//
// WHY. The page used to draw every implementation at once: ~2,400 Rust cards and ~3,200 edges as DOM, with no
// culling, in a ~3,870 x 14,914 px world. It now opens on the crates and you drill into one. jsdom has no
// layout, so the vitest suite can say the cards exist and nothing about what the page costs to open — and the
// desktop app is not always running. This is the part in between, and it is the same shape as the Memory
// harness: one Tauri shim, everything above it shipped code.
//
// ⚠️ CHROMIUM IS NOT WEBKITGTK. A number here is evidence about the APP's work, not the shipping renderer.
import "@/styles/tokens.css";
import.meta.glob("@/**/*.css", { eager: true });

export interface LayerMetrics {
  ok: true;
  /** From render() to the first layer drawn. */
  drawnMs: number;
  /** Main-thread blocks over 50 ms during the mount, longest first. */
  longTasksMs: number[];
  domElements: number;
  /** Cards on the layer: group cards, implementation cards, stub cards. */
  groups: number;
  impls: number;
  stubs: number;
  /** The toolbar's own summary line — what the page says it is showing. */
  summary: string;
}

/** `graph_dump`'s shape: the index the page renders, bodies dropped. */
type Doc = { implementations: unknown[] };

function installTauriShim(doc: Doc): void {
  let next = 1;
  (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ = {
    transformCallback: (cb: unknown) => {
      const n = next++;
      (window as unknown as Record<string, unknown>)[`_${n}`] = cb;
      return n;
    },
    invoke: async (cmd: string) => {
      if (cmd === "graph_dump") return doc;
      if (cmd === "graph_sig") return "harness";
      if (cmd === "graph_modules") return { implementations: [] };
      return undefined;
    },
    convertFileSrc: (p: string) => p,
    unregisterCallback: () => undefined,
  };
}

const count = (sel: string) => document.querySelectorAll(sel).length;
/** The TOOLBAR's summary line — the one that says what the layer is showing.
 *
 *  Not `.algorithms-workspace .mono`: the first mono element on the page is a tab's count badge, so that
 *  selector reported "363" (a group's size) as the summary. Pick the mono line that actually reads like the
 *  summary instead. */
const summaryText = () =>
  ([...document.querySelectorAll(".algorithms-workspace .mono")]
    .map((el) => (el.textContent ?? "").trim())
    .find((t) => /impls|groups|folders/.test(t)) ?? "");

async function settle(): Promise<void> {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise((r) => setTimeout(r, 60));
}

/** Mount the page over `doc` and report what the FIRST layer drew. */
async function mount(doc: Doc): Promise<LayerMetrics | { ok: false; error: string }> {
  try {
    installTauriShim(doc);
    const long: number[] = [];
    new PerformanceObserver((entries) => {
      for (const e of entries.getEntries()) long.push(Math.round(e.duration));
    }).observe({ type: "longtask", buffered: false });

    const [{ AlgorithmsWorkspace }, React, ReactDOMClient] = await Promise.all([
      import("@/features/algorithms/AlgorithmsWorkspace"),
      import("react"),
      import("react-dom/client"),
    ]);
    const root = document.getElementById("root");
    if (!root) throw new Error("no #root");

    const t0 = performance.now();
    ReactDOMClient.createRoot(root).render(React.createElement(AlgorithmsWorkspace));
    const deadline = t0 + 60_000;
    while (count(".algo-node") === 0) {
      if (performance.now() > deadline) throw new Error("no cards drawn in 60 s");
      await new Promise((r) => requestAnimationFrame(r));
    }
    const drawnMs = Math.round(performance.now() - t0);
    await settle();

    return {
      ok: true,
      drawnMs,
      longTasksMs: long.sort((a, b) => b - a),
      domElements: document.getElementsByTagName("*").length,
      groups: count(".algo-group"),
      impls: count("[data-impl]"),
      stubs: count(".algo-stub"),
      summary: summaryText(),
    };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 400) };
  }
}

/** Switch language tab by its label, then report the layer.
 *
 *  A page tab is a `[data-tab]` element (TabBar), NOT a button or a `role="tab"` — the first run of this
 *  harness looked for those and found nothing, and the error said only that the tab was missing. It names the
 *  labels it DID see now, so the next failure explains itself. */
async function openTech(label: string): Promise<LayerMetrics | { ok: false; error: string }> {
  const tabs = [...document.querySelectorAll("[data-tab]")];
  const tab = tabs.find((el) => (el.textContent ?? "").trim().startsWith(label));
  if (!tab) return { ok: false, error: `no tab labelled ${label} — saw [${tabs.map((t) => (t.textContent ?? "").trim()).join(", ")}]` };
  (tab as HTMLElement).click();
  await settle();
  return { ok: true, drawnMs: 0, longTasksMs: [], domElements: document.getElementsByTagName("*").length, groups: count(".algo-group"), impls: count("[data-impl]"), stubs: count(".algo-stub"), summary: summaryText() };
}

/** Enter the group card whose label matches, then report the layer it drew. */
async function enter(label: string): Promise<LayerMetrics | { ok: false; error: string }> {
  const cards = [...document.querySelectorAll(".algo-group")];
  const card = cards.find((el) => el.querySelector(".algo-name")?.textContent?.trim() === label);
  if (!card) {
    const seen = cards.slice(0, 12).map((el) => el.querySelector(".algo-name")?.textContent?.trim() ?? "?");
    return { ok: false, error: `no group card ${label} among ${cards.length}: [${seen.join(", ")}]` };
  }
  const t0 = performance.now();
  (card as HTMLElement).click();
  await settle();
  return { ok: true, drawnMs: Math.round(performance.now() - t0), longTasksMs: [], domElements: document.getElementsByTagName("*").length, groups: count(".algo-group"), impls: count("[data-impl]"), stubs: count(".algo-stub"), summary: summaryText() };
}

/** Step out one layer with the page's own Back button. */
async function back(): Promise<LayerMetrics | { ok: false; error: string }> {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Back"));
  if (!btn) return { ok: false, error: "no Back button on a drilled layer" };
  btn.click();
  await settle();
  return { ok: true, drawnMs: 0, longTasksMs: [], domElements: document.getElementsByTagName("*").length, groups: count(".algo-group"), impls: count("[data-impl]"), stubs: count(".algo-stub"), summary: summaryText() };
}

declare global {
  interface Window {
    __algorithmsGraphHarness?: { mount: typeof mount; openTech: typeof openTech; enter: typeof enter; back: typeof back };
  }
}

window.__algorithmsGraphHarness = { mount, openTech, enter, back };
