// primitiveHarness (ui-registry-resolves-from-the-graph) — the browser half of the render-seam e2e.
//
// WHAT jsdom COULD NOT SHOW. `graphPrimitive.test.tsx` mocks the loader, because compiling record source
// needs esbuild-WASM and that has no Node path — so it proves the WIRING (the join goes through `provides`,
// props pass through, failures land on the bundled component) and explicitly does not claim the real
// compile works. This closes that: source → esbuild → eval → registry-resolved require → render, driven
// through `KitRenderer` exactly as the app does, in real Chromium.
//
// UNLIKE `loaderHarness.ts` THIS USES THE REAL STORE, and that is the point rather than an oversight.
// `primitiveFor` resolves by reading `useAppStore.getState().components` and matching a record's
// `provides`; a store stub would test a resolver this code does not have. The store is imported for its
// `components` slice alone and seeded directly with `setState` — nothing here hydrates, invokes Tauri, or
// touches persistence.
import * as React from "react";
import * as ReactDOMClient from "react-dom/client";
import { useAppStore } from "@/store";
import { registerPlatformModules } from "@/app/runtime/appModules";
import { KitRenderer } from "@/shared/ui/spec";
import type { GeneralNode } from "@/shared/ui/spec";
import "@/styles/tokens.css";

// The registry must be POPULATED or nothing loads: a compiled record's `require("react/jsx-runtime")`
// resolves through it, so with an empty registry every record fails and the seam silently serves the
// bundled component — which looks exactly like "no record provides this". `main.tsx` calls this at boot;
// the harness has to as well, or it would be testing the fallback path three times over.
registerPlatformModules();

/** A record PROVIDING the Text primitive's specifier, rendering something the bundled Text never would.
 *  The marker is what distinguishes the two — both render the text, so "it rendered" proves nothing. */
const TEXT_RECORD = {
  id: "e2e-graph-text",
  name: "Text",
  kitId: "base-studio-code",
  role: "primitive",
  provides: "@/shared/ui/typography/Text",
  srcText:
    'export function Text({ children }) {\n' +
    '  return <span data-testid="from-the-graph">{children}</span>;\n' +
    "}\n",
};

const NODE = { type: "Text", props: { children: "hello" } } as unknown as GeneralNode;

// ONE root, re-rendered. `createRoot` per mount makes a second root fight the first over the same
// container — React warns, then throws `removeChild ... not a child of this node` when one unmounts a
// node the other owns. Harmless to the assertions and fatal to `expect(pageerrors).toEqual([])`, which
// is the point of keeping that assertion.
let root: ReactDOMClient.Root | undefined;

function mount(records: unknown[]) {
  useAppStore.setState({ components: records as never });
  root ??= ReactDOMClient.createRoot(document.getElementById("root")!);
  root.render(React.createElement(KitRenderer, { node: NODE }));
}

const BROKEN_SRC = "export function Text() { return <span unterminated }";

declare global {
  interface Window {
    __primitiveHarness?: {
      /** No record provides the primitive → the bundled component must render. */
      mountBundled: () => void;
      /** A record provides it → the GRAPH copy must replace the bundled fallback. */
      mountGraph: () => void;
      /** A broken edit to a record that HAS compiled before → GraphComponent's last-good wins. */
      mountBrokenEdit: () => void;
      /** A record that has NEVER compiled → no last-good exists, so the bundled component must survive. */
      mountBrokenFresh: () => void;
    };
  }
}

window.__primitiveHarness = {
  mountBundled: () => mount([]),
  mountGraph: () => mount([TEXT_RECORD]),
  mountBrokenEdit: () => mount([{ ...TEXT_RECORD, srcText: BROKEN_SRC }]),
  // A DIFFERENT id, so `lastGood` (which is keyed per id) is empty for it — the only way to reach the
  // bundled-component path once a record of the same id has already rendered once.
  mountBrokenFresh: () => mount([{ ...TEXT_RECORD, id: "e2e-graph-text-never-worked", srcText: BROKEN_SRC }]),
};
