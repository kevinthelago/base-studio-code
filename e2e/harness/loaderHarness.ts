// loaderHarness (#3635) — the browser half of the runtime-loader e2e. The loader's compile step is
// esbuild-WASM (browser-only, no Node path), so a real-Chromium run is the ONLY place the whole chain is
// exercised end to end: source → `compileToCjs` (esbuild) → `evalCjsModule` → registry-resolved `require` →
// render — with imports resolved to the app's OWN React (shared instance ⇒ hooks fire), a REAL `shared/ui`
// primitive, and a VENDORED graph sibling, exactly as `GraphComponent` does at runtime.
//
// Deliberately a self-contained REPRESENTATIVE page, NOT the live fleetpage: `previewHarness.ts` documents
// why rendering a store/Tauri-bound component headlessly tests the app's wiring at a large cost in fragility.
// The mechanism is what needs the browser (Slice 1 proved it by hand, #3605); the fleetpage's presentation is
// covered by the seed round-trip + the import guards + the live proof. This closes the coverage the deleted
// Fleet.tsx render tests (#3608) point to, on the part jsdom structurally cannot see.
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as ReactDOMClient from "react-dom/client";
import * as Text from "@/shared/ui/typography/Text";
import { registerAppModule, __resetRegistry } from "@/shared/lib/runtime/moduleRegistry";
import { loadComponentFromSource } from "@/shared/lib/runtime/componentLoader";
import "@/styles/tokens.css";

// A minimal `@/store` stand-in — the loader MECHANISM is under test here, not the real store.
const STORE_STUB = { useAppStore: (sel: (s: { tally: number }) => unknown) => sel({ tally: 7 }) };

// A representative GRAPH page (compiled at runtime): a real React hook, `@/store` (→ the stub), a REAL
// `shared/ui` primitive, a graph SIBLING via `@/components/<id>`, and a `@/shared/ui/*` primitive that a
// graph component OVERRIDES via `provides` (#3660) — all vendored/resolved by the resolver below.
const PAGE_SOURCE = `
import { useState } from "react";
import { useAppStore } from "@/store";
import { Text } from "@/shared/ui/typography/Text";
import { Badge } from "@/components/probe-badge";
import { ProbeTile } from "@/shared/ui/probe-tile";
export function Probe() {
  const [n, setN] = useState(0);
  const tally = useAppStore(function (s) { return s.tally; });
  return (
    <div>
      <div data-testid="probe">tally:{tally} clicks:{n}</div>
      <Text as="div">from a real shared/ui Text</Text>
      <Badge label="vendored" />
      <ProbeTile />
      <button data-testid="bump" onClick={function () { setN(n + 1); }}>bump</button>
    </div>
  );
}
`;

const SIBLING_SOURCE = `
export function Badge({ label }) {
  return <span data-testid="sibling">sibling:{label}</span>;
}
`;

// A graph component that PROVIDES a shared/ui specifier (#3660) — the loader must vendor THIS over the
// registered platform module below, so `data-testid="provide"` reads "graph", not "platform".
const PROVIDES_SOURCE = `
export function ProbeTile() {
  return <span data-testid="provide">graph</span>;
}
`;

const resolveGraphSource = (spec: string): string | null =>
  spec === "@/components/probe-badge" ? SIBLING_SOURCE
  : spec === "@/shared/ui/probe-tile" ? PROVIDES_SOURCE // graph-first: overrides the registered module
  : null;

/** Compile + load + mount the representative page; rejects (→ the spec fails) on any loader error. */
async function load(): Promise<void> {
  __resetRegistry();
  registerAppModule("react", React);
  registerAppModule("react/jsx-runtime", JsxRuntime);
  registerAppModule("@/store", STORE_STUB);
  registerAppModule("@/shared/ui/typography/Text", Text);
  // Register a PLATFORM ProbeTile that renders "platform" — graph-first (#3660) must SHADOW it with the
  // provided graph source, so if the override works this registered module is never reached.
  registerAppModule("@/shared/ui/probe-tile", {
    ProbeTile: () => React.createElement("span", { "data-testid": "provide" }, "platform"),
  });
  const Loaded = await loadComponentFromSource(PAGE_SOURCE, resolveGraphSource);
  ReactDOMClient.createRoot(document.getElementById("root")!).render(React.createElement(Loaded));
}

declare global {
  interface Window {
    __loaderHarness?: { load: () => Promise<void> };
  }
}

window.__loaderHarness = { load };
