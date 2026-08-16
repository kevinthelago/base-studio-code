/**
 * @vitest-environment jsdom
 *
 * This file lives under `lib/`, which vitest's `node` project covers, but it genuinely needs a DOM.
 * A per-file docblock beats the project's environment, so the requirement is stated where a reader
 * meets it. See the `projects` split in vitest.config.ts for why the default is `node` here.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import * as React from "react";
import { registerAppModule, __resetRegistry } from "@/shared/lib/runtime/moduleRegistry";
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

describe("routeImport — everything is external now; graph-first moved to the require chain", () => {
  it("leaves EVERY import external, including the graph specifiers it used to vendor", () => {
    registerAppModule("react", React);
    registerAppModule("@/shared/ui/data/Chip", { Chip: () => null }); // the bundled platform Chip
    const graph: Record<string, string> = {
      "@/components/worker-board": "export const P = () => null;", //  a graph SIBLING
      "@/shared/ui/data/Chip": "export const Chip = () => null;", //   a graph OVERRIDE (#3660)
    };
    const resolve = (s: string) => graph[s] ?? null;

    // A record is a MODULE, not source to inline. Both of these used to return `{ vendor }`; they are
    // now linked separately and resolved by `require`, which is what stops a page recompiling its whole
    // subtree on every mount. GRAPH-FIRST (#3660) did not go away — it moved to `makeGraphRequire`,
    // where the linked set is consulted before the registry (see graphModules.test.ts).
    expect(routeImport("@/shared/ui/data/Chip", resolve)).toEqual({ external: true });
    expect(routeImport("@/components/worker-board", resolve)).toEqual({ external: true });
    expect(routeImport("react", resolve)).toEqual({ external: true });
    expect(routeImport("@/components/missing", resolve)).toEqual({ external: true });
    expect(routeImport("d3", resolve)).toEqual({ external: true });
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

  // #85 — a record is transcribed from a real module, so it can carry a Vite `?raw` import exactly as
  // `persona.ts` does. The `?raw` suffix means the specifier can NEVER be a registered app module, so
  // before this it hit the throw above and took the whole record down. There is no filesystem at this
  // layer, so the text is empty — but it is a STRING, which is the shape the importing code was written
  // against (`overlayRaw(rel, md).trim()`).
  it("answers a ?raw / ?url import with a string default instead of throwing", () => {
    const req = makeRequire();
    const raw = req("@data/fleet/worker-protocol.md?raw") as { default: string };
    expect(typeof raw.default).toBe("string");
    expect(raw.default).toBe("");
    // `?url` carries its own path as the value — still a string.
    expect((req("@/assets/logo.svg?url") as { default: string }).default).toBe("@/assets/logo.svg");
    // The suffix is what makes it ours; the unsuffixed specifier still fails loudly.
    expect(() => req("@data/fleet/worker-protocol.md")).toThrow(/is not a registered app module/);
  });
});

describe("pickComponent (#3605)", () => {
  it("takes the default export, else the first exported function, else null", () => {
    const f = () => null;
    expect(pickComponent({ default: f })).toBe(f);
    expect(pickComponent({ Widget: f, meta: 3 })).toBe(f);
    expect(pickComponent({ meta: 3 })).toBeNull();
  });

  // A record provides a MODULE, and 14 of the 69 manifest primitives share 3 specifiers — so the host has
  // to be able to say WHICH export it wants (graph-primitive-resolves-a-module-not-an-export).
  it("picks the export the caller NAMED, over the default and over the first function", () => {
    const TextField = () => null, TextArea = () => null, dflt = () => null;
    expect(pickComponent({ default: dflt, TextField, TextArea }, "TextArea")).toBe(TextArea);
    expect(pickComponent({ TextField, TextArea }, "TextField")).toBe(TextField);
  });

  it("REFUSES to guess when the named export is missing and the module exports several", () => {
    const a = () => null, b = () => null;
    // `null` sends the host to its fallback — the bundled primitive, which is correct. Guessing here is
    // what rendered a <select class="input" type="password" /> for a password field.
    expect(pickComponent({ TextField: a, SelectField: b }, "TextArea")).toBeNull();
    expect(pickComponent({ default: a, SelectField: b }, "TextArea")).toBeNull();
  });

  it("still resolves a SINGLE-component module whose export name differs — the refusal must stay narrow", () => {
    const only = () => null;
    // Otherwise the graph override would be silently dead for every record using a default export, or one
    // whose export name simply is not the primitive's name.
    expect(pickComponent({ default: only }, "TextField")).toBe(only);
    expect(pickComponent({ Field: only }, "TextField")).toBe(only);
    // `export default X` alongside `export { X }` is two entries and ONE component, not an ambiguity.
    expect(pickComponent({ default: only, Field: only, meta: 3 }, "TextField")).toBe(only);
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
