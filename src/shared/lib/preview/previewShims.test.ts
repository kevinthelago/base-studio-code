import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { createElement } from "react";
import {
  STUB_HELPER,
  universalStub,
  scanStubImports,
  DEDICATED_SHIMS,
  shimModuleFor,
  PREVIEW_CSP,
  previewCspMeta,
  PREVIEW_SHIM_NAMESPACE,
} from "./previewShims";

/** Reconstruct `makeStub` from the helper source the generated ESM stub inlines, so we can exercise the
 *  exact black-hole value a stubbed import binds to. */
function makeStubFn(): (name: string) => unknown {
  return new Function(`${STUB_HELPER}\nreturn makeStub;`)() as (name: string) => unknown;
}

describe("makeStub — a black hole that satisfies any usage shape (#3696)", () => {
  const makeStub = makeStubFn();

  it("a capitalized name is a component that renders its children", () => {
    const Stack = makeStub("Stack") as never;
    expect(render(createElement(Stack, null, "hello")).container.textContent).toBe("hello");
    expect(() => render(createElement(Stack, null))).not.toThrow(); // childless → null, no crash
  });

  it("a nested access (Stack.Screen) is also a renderable component", () => {
    const Screen = (makeStub("Stack") as Record<string, unknown>).Screen as never;
    expect(typeof Screen).toBe("function");
    expect(() => render(createElement(Screen, null, "x"))).not.toThrow();
  });

  it("a use* name is a hook whose result is safe to access, call, and destructure", () => {
    const r = (makeStub("useRouter") as () => Record<string, () => void>)();
    expect(() => r.push()).not.toThrow();
    expect(() => (r as unknown as { a: { b: () => void } }).a.b()).not.toThrow();
    const [state, request] = (makeStub("useCameraPermissions") as () => unknown[])();
    expect(state).toBeDefined();
    expect(request).toBeDefined();
  });

  it("a stubbed value coerces to a benign primitive (never throws in a style/number context)", () => {
    const insets = (makeStub("useSafeAreaInsets") as () => Record<string, unknown>)();
    expect(Number(insets.top)).toBe(0);
    expect(String(insets.label)).toBe("");
    expect(`${insets.anything}`).toBe("");
  });

  it("is never thenable (safe under await / React.lazy)", () => {
    expect((makeStub("whatever") as Record<string, unknown>).then).toBeUndefined();
  });

  it("a component consuming a stubbed hook + value renders without crashing", () => {
    const useInsets = makeStub("useSafeAreaInsets") as () => Record<string, number>;
    const useRouter = makeStub("useRouter") as () => { push: () => void };
    function Screen() {
      const insets = useInsets();
      const { push } = useRouter();
      return createElement("div", { style: { paddingTop: insets.top }, onClick: push }, "screen");
    }
    expect(render(createElement(Screen)).container.textContent).toBe("screen");
  });
});

describe("universalStub — exports exactly the imported names (esbuild resolves them statically)", () => {
  it("emits an export per name plus a default", () => {
    const src = universalStub(["Stack", "useRouter", "router"]);
    expect(src).toContain('export const Stack = makeStub("Stack");');
    expect(src).toContain('export const useRouter = makeStub("useRouter");');
    expect(src).toContain('export const router = makeStub("router");');
    expect(src).toContain('export default makeStub("Default");');
    expect(src).toContain("function makeStub("); // the helper is inlined
  });

  it("drops `default` + non-identifier names (a malformed scan can't emit invalid JS)", () => {
    const src = universalStub(["default", "1bad", "ok-nope", "Fine"]);
    expect(src).toContain("export const Fine =");
    expect(src).not.toContain("1bad");
    expect(src).not.toContain("ok-nope");
    expect(src.match(/export default/g)).toHaveLength(1); // the ONE default, not a `default` named export
  });
});

describe("scanStubImports — collects the names each stubbed package is imported with", () => {
  it("unions named bindings, skips externals / dedicated shims / first-party", () => {
    const files = {
      "a.ts":
        "import { Stack, useRouter as r } from 'expo-router';\n" +
        "import { type Href, router } from 'expo-router';\n" + // union + `type` stripped
        "import React from 'react';\n" +                       // external → skipped
        "import { View } from 'react-native';\n" +             // dedicated shim → skipped
        "import { Card } from '@/shared/ui/Card';\n",          // first-party → skipped
    };
    const map = scanStubImports(files, (s) => s === "react");
    expect([...(map.get("expo-router") ?? [])].sort()).toEqual(["Href", "Stack", "router", "useRouter"]);
    expect(map.has("react")).toBe(false);
    expect(map.has("react-native")).toBe(false);
    expect(map.has("@/shared/ui/Card")).toBe(false);
  });
});

describe("shim resolution + CSP", () => {
  it("react-native / react-native-svg get dedicated fidelity shims; everything else gets a universal stub", () => {
    expect(shimModuleFor("react-native")).toBe(DEDICATED_SHIMS["react-native"]);
    expect(shimModuleFor("react-native")).toContain("flexDirection");      // real RN layout
    expect(shimModuleFor("react-native-svg")).toContain('svg("circle")');  // real SVG DOM
    expect(shimModuleFor("expo-router", ["Stack"])).toContain('export const Stack = makeStub("Stack");');
    expect(shimModuleFor("some-made-up-pkg", ["thing"])).toContain('export const thing = makeStub("thing");');
  });

  it("PREVIEW_SHIM_NAMESPACE is stable (shared by both preview bundlers)", () => {
    expect(PREVIEW_SHIM_NAMESPACE).toBe("preview-shim");
  });

  it("the CSP blocks exfiltration + uncurated code, and allows only esm.sh + inline", () => {
    expect(PREVIEW_CSP).toContain("connect-src 'none'");   // no fetch/xhr/ws/beacon → no exfil
    expect(PREVIEW_CSP).toContain("default-src 'none'");
    expect(PREVIEW_CSP).toContain("script-src 'unsafe-inline' https://esm.sh");
    // data: is allowed for img/font (art), but NEVER for script — a bundled stub is not a data: script.
    const scriptSrc = PREVIEW_CSP.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src")) ?? "";
    expect(scriptSrc).not.toContain("data:");
    expect(previewCspMeta()).toBe(`<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}" />`);
  });
});
