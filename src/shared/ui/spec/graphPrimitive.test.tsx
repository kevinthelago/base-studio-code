// Does the render seam actually reach the GRAPH? (ui-registry-resolves-from-the-graph)
//
// The assertion that matters is not "a component rendered" — the bundled fallback would satisfy that and
// the whole change would be a no-op nobody noticed. Each test here makes the record differ OBSERVABLY
// from the bundled component, so only the graph copy can produce the expected DOM.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// THE LOADER IS MOCKED, for the same reason GraphComponent.test.tsx mocks it: compiling real record
// source needs esbuild, which jsdom cannot run. So this file proves the WIRING — that the seam reaches
// the graph, that the join goes through `provides`, that identity is stable, and that every failure path
// lands on the bundled component.
//
// It deliberately does NOT claim the real compile works. That half is already covered, separately: the
// browser harnesses (`e2e/recordLinks.spec.ts`, `e2e/graphPages.spec.ts`) compile every packaged record
// with the real esbuild-wasm chain. The two together are the argument — records compile there, and the
// seam reaches them here. What NEITHER covers is a real record rendering through a real store, because
// `e2e/harness/graph-pages-harness.html` says outright that rendering needs the Tauri store a browser
// harness has not got. That remains the live-verify step on a dev instance.
const load = vi.hoisted(() => vi.fn());
vi.mock("@/shared/lib/runtime/componentLoader", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadComponentFromSource: load,
}));
import { KitRenderer } from "./KitRenderer";
import { primitiveFor, __resetPrimitiveCache } from "./graphPrimitive";
import { componentFor } from "@/shared/ui/registry";
import { useAppStore } from "@/store";
import type { GeneralNode } from "@/shared/ui/spec/generalNode";

/** A record that PROVIDES `@/shared/ui/typography/Text` and renders something the real Text never would. */
const TEXT_RECORD = {
  id: "test-graph-text",
  name: "Text",
  kitId: "base-studio-code",
  role: "primitive",
  provides: "@/shared/ui/typography/Text",
  srcText:
    'export function Text({ children }: { children?: unknown }) {\n' +
    '  return <span data-testid="from-the-graph">{children as never}</span>;\n' +
    "}\n",
};

const seed = (records: unknown[]) => {
  useAppStore.setState({ components: records as never });
};

describe("primitiveFor — graph-first resolution", () => {
  beforeEach(() => {
    __resetPrimitiveCache();
    seed([]);
  });
  afterEach(() => {
    __resetPrimitiveCache();
    seed([]);
  });

  it("returns the BUNDLED component when no record provides the primitive's specifier", () => {
    // 24 manifest primitives have no record today; they must keep rendering, silently.
    expect(primitiveFor("Text")).toBe(componentFor("Text"));
  });

  it("returns the bundled component for `Slot`, which will never have a record", () => {
    seed([TEXT_RECORD]);
    expect(primitiveFor("Slot")).toBe(componentFor("Slot"));
  });

  it("returns a DIFFERENT component once a record provides that specifier", () => {
    seed([TEXT_RECORD]);
    const resolved = primitiveFor("Text");
    expect(resolved).toBeDefined();
    expect(resolved).not.toBe(componentFor("Text"));
  });

  it("is referentially STABLE across calls — a fresh identity would remount the subtree every render", () => {
    seed([TEXT_RECORD]);
    expect(primitiveFor("Text")).toBe(primitiveFor("Text"));
  });

  it("keeps identity stable when the record's SOURCE changes, so an edit recompiles in place", () => {
    seed([TEXT_RECORD]);
    const first = primitiveFor("Text");
    seed([{ ...TEXT_RECORD, srcText: TEXT_RECORD.srcText.replace("span", "div") }]);
    expect(primitiveFor("Text")).toBe(first);
  });
});

describe("KitRenderer — which copy reaches the DOM", () => {
  beforeEach(() => {
    __resetPrimitiveCache();
    seed([]);
    load.mockReset();
  });
  afterEach(() => {
    __resetPrimitiveCache();
    seed([]);
  });

  const node = { type: "Text", props: { children: "hello" } } as unknown as GeneralNode;

  it("renders the BUNDLED Text when nothing provides it, and never calls the loader", () => {
    render(<KitRenderer node={node} />);
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.queryByTestId("from-the-graph")).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("mounts the RECORD's component once one provides that specifier", async () => {
    seed([TEXT_RECORD]);
    load.mockResolvedValue(({ children }: { children?: unknown }) => (
      <span data-testid="from-the-graph">{children as never}</span>
    ));
    render(<KitRenderer node={node} />);
    // The bundled copy renders first (the fallback, while the record loads) and the graph copy replaces
    // it. Both render the text, so the testid is the only thing that distinguishes them.
    await waitFor(() => expect(screen.getByTestId("from-the-graph")).toBeTruthy());
    expect(screen.getByText("hello")).toBeTruthy();
    // It was handed the RECORD's source, not the file's — the join actually went through `provides` —
    // AND the primitive NAME as the export to mount, which is the other half of the join: a record
    // provides a module, and a module can export several primitives.
    expect(load).toHaveBeenCalledWith(TEXT_RECORD.srcText, expect.anything(), "Text");
  });

  it("passes the node's props THROUGH to the graph copy", async () => {
    seed([TEXT_RECORD]);
    load.mockResolvedValue((p: Record<string, unknown>) => (
      <span data-testid="from-the-graph">{String(p.children)}</span>
    ));
    render(<KitRenderer node={{ type: "Text", props: { children: "payload" } } as unknown as GeneralNode} />);
    await waitFor(() => expect(screen.getByTestId("from-the-graph").textContent).toBe("payload"));
  });

  it("falls back to the bundled component when the record fails to load", async () => {
    seed([TEXT_RECORD]);
    load.mockRejectedValue(new Error("Unexpected token"));
    render(<KitRenderer node={node} />);
    // Never blank: a primitive that renders nothing is indistinguishable from "the data said render nothing".
    await waitFor(() => expect(screen.getByText("hello")).toBeTruthy());
    expect(screen.queryByTestId("from-the-graph")).toBeNull();
  });
});

// The bug this pair guards (graph-primitive-resolves-a-module-not-an-export). 14 of the 69 manifest
// primitives share 3 specifiers, so the name→specifier→record join is NOT one-to-one: a record provides a
// MODULE. `@/shared/ui/controls/Field` exports TextField, TextArea and SelectField, and `ui-field` provides
// it — so before the export name was part of the join, all three mounted whichever function the loader
// picked first, and a password TextField rendered as `<select class="input" type="password" />`.
describe("a record that provides a MULTI-EXPORT module (graph-primitive-resolves-a-module-not-an-export)", () => {
  /** One record standing in for `ui-field` — the module every Field primitive resolves to. */
  const FIELD_RECORD = {
    id: "test-graph-field",
    name: "Field",
    kitId: "base-studio-code",
    role: "primitive",
    provides: "@/shared/ui/controls/Field",
    srcText: "export function TextField() { return null; }\n",
  };

  beforeEach(() => { __resetPrimitiveCache(); seed([FIELD_RECORD]); });
  afterEach(() => { __resetPrimitiveCache(); seed([]); load.mockReset(); });

  it("asks the loader for the export matching EACH primitive, not just the module", () => {
    for (const name of ["TextField", "TextArea", "SelectField"] as const) {
      load.mockReset();
      load.mockResolvedValue(() => <i data-testid={`graph-${name}`} />);
      const Comp = primitiveFor(name)!;
      render(<Comp />);
      expect(load).toHaveBeenCalledWith(FIELD_RECORD.srcText, expect.anything(), name);
    }
  });

  it("gives each primitive its OWN wrapper — one record, three components", () => {
    const [a, b, c] = (["TextField", "TextArea", "SelectField"] as const).map((n) => primitiveFor(n));
    // Same record id. A wrapper cache keyed on the id alone returned ONE component for all three, which is
    // the shape of the original defect: the second primitive silently rendered the first one's export.
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
