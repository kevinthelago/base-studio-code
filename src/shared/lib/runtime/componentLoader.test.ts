import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import * as React from "react";
import { registerAppModule, __resetRegistry } from "./moduleRegistry";
import { classifyImport, makeRequire, pickComponent, evalCjsModule, routeImport } from "./componentLoader";

// The compile step (esbuild-wasm, browser-only) is exercised end-to-end by the e2e harness; here we verify
// the runtime half — that the CommonJS esbuild WOULD emit runs against the registry, resolving `react` to
// the app's real instance so a loaded component's HOOKS fire, and a `@/…` platform module to its live value.

/** The exact CJS shape esbuild emits for `import {useState} from "react"; import {useCount} from "@/store"`
 *  plus JSX — hand-written so this test needs no browser bundler. */
const CJS = `
const react = require("react");
const store = require("@/store");
function Widget() {
  const [bump, setBump] = react.useState(0);      // a REAL React hook must fire → shared instance
  const n = store.useCount();                     // a live platform module, resolved from the registry
  return react.createElement(
    "button",
    { "data-testid": "w", onClick: function () { setBump(bump + 1); } },
    "count:" + n + " bump:" + bump,
  );
}
module.exports = { Widget: Widget };
`;

beforeEach(() => __resetRegistry());

describe("classifyImport (#3605)", () => {
  it("registered → platform · first-party → graph · bare → library", () => {
    const registered = (s: string) => s === "react" || s === "@/store";
    expect(classifyImport("react", registered)).toBe("platform");
    expect(classifyImport("@/store", registered)).toBe("platform"); // registered wins over the @/ shape
    expect(classifyImport("@/shared/ui/data/Card", registered)).toBe("graph");
    expect(classifyImport("./Sibling", registered)).toBe("graph");
    expect(classifyImport("d3", registered)).toBe("library");
  });
});

describe("routeImport — GRAPH-FIRST: resolver override · sibling vendored · else external (#3606/#3660)", () => {
  it("a resolved specifier vendors (even one it OVERRIDES); everything unresolved → external (code fallback)", () => {
    registerAppModule("react", React);
    registerAppModule("@/store", {});
    registerAppModule("@/shared/ui/data/Chip", { Chip: () => null }); // the bundled platform Chip…
    const graph: Record<string, string> = {
      "@/components/worker-board": "export const P = () => null;", //          …a graph SIBLING
      "@/shared/ui/data/Chip": "export const Chip = () => null;", //           …a graph OVERRIDE of the platform Chip (#3660)
    };
    const resolve = (s: string) => graph[s] ?? null;

    // GRAPH-FIRST (#3660): a component that PROVIDES a platform specifier overrides the registry → vendored,
    // so a shared/ui primitive can render from the graph (DATA) rather than the bundled module.
    expect(routeImport("@/shared/ui/data/Chip", resolve)).toEqual({ vendor: graph["@/shared/ui/data/Chip"] });
    // a graph sibling the app resolves → vendored (its source bundles in)
    expect(routeImport("@/components/worker-board", resolve)).toEqual({ vendor: graph["@/components/worker-board"] });
    // an UNRESOLVED registered module → external → the registry (the code fallback, identical to pre-#3660)
    expect(routeImport("react", resolve)).toEqual({ external: true });
    expect(routeImport("@/store", resolve)).toEqual({ external: true });
    // a first-party path the resolver does NOT know → external (→ require throws a named error)
    expect(routeImport("@/components/missing", resolve)).toEqual({ external: true });
    // a bare library → external
    expect(routeImport("d3", resolve)).toEqual({ external: true });
    // no resolver at all → degrades to #3605 "everything external" (no override possible)
    expect(routeImport("@/shared/ui/data/Chip")).toEqual({ external: true });
  });
});

describe("makeRequire (#3605)", () => {
  it("returns the registered module, and throws a NAMED error for an unregistered one (never a stub)", () => {
    registerAppModule("react", React);
    const req = makeRequire();
    expect(req("react")).toBe(React);
    expect(() => req("@/store")).toThrow(/import "@\/store" is not a registered app module/);
  });
});

describe("pickComponent (#3605)", () => {
  it("takes the default export, else the first exported function, else null", () => {
    const f = () => null;
    expect(pickComponent({ default: f })).toBe(f);
    expect(pickComponent({ Widget: f, meta: 3 })).toBe(f);
    expect(pickComponent({ meta: 3 })).toBeNull();
  });
});

describe("evalCjsModule — graph code runs live against the registry (#3605)", () => {
  it("resolves real React (hooks fire) + a live platform module, and renders in the app tree", () => {
    registerAppModule("react", React); // the SAME instance the test renderer uses → hooks are valid
    registerAppModule("@/store", { useCount: () => 7 });

    const exports = evalCjsModule(CJS, makeRequire());
    const Widget = pickComponent(exports);
    expect(Widget).not.toBeNull();

    render(React.createElement(Widget!));
    const btn = screen.getByTestId("w");
    expect(btn.textContent).toBe("count:7 bump:0"); // the live "@/store" read resolved

    fireEvent.click(btn);
    expect(btn.textContent).toBe("count:7 bump:1"); // the loaded component's OWN useState updated → React shared
  });
});
