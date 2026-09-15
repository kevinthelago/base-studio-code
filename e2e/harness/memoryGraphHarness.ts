// Memory graph harness (the-memory-graph-is-tested-in-a-real-browser) — mounts the REAL MemoryWorkspace in real
// Chromium at the size of the store, and measures what drawing it costs.
//
// WHY THIS EXISTS. The Memory page draws every open memory (~1,400 cards, ~3,200 edges). jsdom has no layout, so
// the vitest suite can say the cards EXIST and nothing about whether the page is usable: how long it blocks the
// main thread, how big the DOM gets, what it looks like. The desktop app is the real check, but it is not always
// running and cannot be driven from a test. This is the part in between.
//
// THE SMALLEST LIE. Tauri v2's api reaches `window.__TAURI_INTERNALS__`; this installs one whose `invoke("bsc")`
// answers `memory list`, `memory graph` and `memory neighbors` from a fixture the spec hands over. Everything
// above that boundary — the workspace, the layout, the canvas, the stylesheet — is the shipped code.
//
// ⚠️ CHROMIUM IS NOT WEBKITGTK. The app ships on WebKitGTK; a number here is evidence about the APP's work (the
// layout, React, the DOM it builds), not a promise about the shipping renderer's speed.
// Every stylesheet, exactly as `src/app/main.tsx` loads them: tokens first, then the `@/**/*.css` glob. A record
// cannot import its own CSS, so the canvas, rail and card styles reach the app only through that glob — import
// fewer here and the screenshot shows an unstyled page the app never renders.
import "@/styles/tokens.css";
import.meta.glob("@/**/*.css", { eager: true });

export interface MountMetrics {
  ok: true;
  /** `layoutMemoryGraph` alone, on the same graph, before the page mounts. */
  layoutMs: number;
  /** From render() to every served node drawn as a card. */
  drawnMs: number;
  /** Every main-thread block over 50 ms the browser reported during the mount, longest first. */
  longTasksMs: number[];
  domElements: number;
  nodeCards: number;
  edges: number;
  similarEdges: number;
  arrowheads: number;
  world: string;
}

type Fixture = { graph: unknown; list: unknown };

function installBscShim(fx: Fixture): void {
  let next = 1;
  const answer = (args: string[]): string => {
    const [noun, verb, id] = args;
    if (noun !== "memory") return "[]";
    if (verb === "list") return JSON.stringify(fx.list);
    if (verb === "graph") return JSON.stringify(fx.graph);
    if (verb === "neighbors") return JSON.stringify({ id, outgoing: [], incoming: [] });
    return "[]";
  };
  (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ = {
    transformCallback: (cb: unknown) => {
      const n = next++;
      (window as unknown as Record<string, unknown>)[`_${n}`] = cb;
      return n;
    },
    invoke: async (cmd: string, payload?: { args?: string[] }) => (cmd === "bsc" ? answer(payload?.args ?? []) : undefined),
    convertFileSrc: (p: string) => p,
    unregisterCallback: () => undefined,
  };
}

async function mount(graph: unknown, list: unknown): Promise<MountMetrics | { ok: false; error: string }> {
  try {
    installBscShim({ graph, list });
    const long: number[] = [];
    const observer = new PerformanceObserver((entries) => {
      for (const e of entries.getEntries()) long.push(Math.round(e.duration));
    });
    observer.observe({ type: "longtask", buffered: false });

    const [{ MemoryWorkspace }, { parseTopicGraph, layoutMemoryGraph }, React, ReactDOMClient] = await Promise.all([
      import("@/features/memory"),
      import("@/features/memory/lib/memory"),
      import("react"),
      import("react-dom/client"),
    ]);
    // The layout ALONE, before anything mounts, so the report can say how much of the block is laying out and
    // how much is React and the DOM.
    const tree = parseTopicGraph(graph);
    const tl = performance.now();
    if (tree) layoutMemoryGraph(tree);
    const layoutMs = Math.round(performance.now() - tl);
    long.length = 0;
    const want = (graph as { nodes?: unknown[] }).nodes?.length ?? 0;
    const root = document.getElementById("root");
    if (!root) throw new Error("no #root");

    const t0 = performance.now();
    ReactDOMClient.createRoot(root).render(React.createElement(MemoryWorkspace));
    const deadline = t0 + 60_000;
    while (document.querySelectorAll(".mem-node").length < want) {
      if (performance.now() > deadline) throw new Error(`drew ${document.querySelectorAll(".mem-node").length} of ${want} cards in 60 s`);
      await new Promise((r) => requestAnimationFrame(r));
    }
    const drawnMs = Math.round(performance.now() - t0);
    // Two frames so the last long task is reported before the observer is read.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 100));
    observer.disconnect();

    const svg = document.querySelector("svg.mem-graph-edges");
    return {
      ok: true,
      layoutMs,
      drawnMs,
      longTasksMs: long.sort((a, b) => b - a),
      domElements: document.getElementsByTagName("*").length,
      nodeCards: document.querySelectorAll(".mem-node").length,
      edges: document.querySelectorAll(".mem-edge").length,
      similarEdges: document.querySelectorAll('.mem-edge[data-rel="similar"]').length,
      arrowheads: document.querySelectorAll(".mem-edge-arrow").length,
      world: svg ? `${svg.getAttribute("width")}x${svg.getAttribute("height")}` : "none",
    };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 400) };
  }
}

declare global {
  interface Window {
    __memoryGraphHarness?: { mount: typeof mount };
  }
}

window.__memoryGraphHarness = { mount };
