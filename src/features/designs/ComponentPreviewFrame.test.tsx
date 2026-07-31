import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ComponentPreviewFrame } from "./ComponentPreviewFrame";
import type { ComponentRecord } from "./lib/model";

// The real GraphComponent compiles graph source via esbuild-wasm against the live app registry — not
// something jsdom can run (no other GraphHost has a mounted test either, for the same reason). Stubbed to
// a marker so this test covers exactly what #3859 added: the ROUTING decision, not the runtime loader
// itself (that's exercised live, per every other GraphHost in this codebase).
vi.mock("@/shared/lib/runtime/GraphComponent", () => ({
  GraphComponent: ({ id }: { id: string }) => <div data-testid="graph-component" data-id={id} />,
}));

// `./lib/libraryModules` eagerly resolves the algorithms graph at import time (`DEFAULT_RESOLVERS`) — a
// module-load-order edge unrelated to routing (this file is the first thing to import
// `ComponentPreviewFrame.tsx` directly; no other designs test does). Stubbed so this test exercises only
// what #3859 changed, not that unrelated cross-graph resolution wiring.
vi.mock("./lib/libraryModules", () => ({
  DEFAULT_SOUND_KIT: { kind: "default" },
  makeLibraryResolvers: () => ({ resolveLibrarySpec: () => null, libraryModuleResolver: () => null }),
}));

const base: ComponentRecord = {
  id: "widget", name: "Widget", kitId: "user-kit", role: "primitive", version: "1", used: 0,
  tags: [], variants: ["default"], composes: [], props: [], whenUse: [], whenNot: [],
  src: "user/Widget.tsx", srcText: "", source: "export function Widget(){ return null; }",
};

describe("ComponentPreviewFrame routing (#3859)", () => {
  it("renders an APP-GRAPH record (kitId === base-studio-code) live through GraphComponent, never the sandbox", () => {
    const comp: ComponentRecord = { ...base, id: "mcppage", name: "McpWorkspace", kitId: "base-studio-code", role: "page" };
    const { container } = render(
      <ComponentPreviewFrame comp={comp} theme="dark" themeId="default" themeVars={{}} width={200} />,
    );
    expect(screen.getByTestId("graph-component").dataset.id).toBe("mcppage");
    expect(container.querySelector("iframe")).toBeNull(); // never the sandboxed build path
  });

  it("renders everything else (third-party / harvested / user-authored) through the sandboxed iframe", () => {
    const { container } = render(
      <ComponentPreviewFrame comp={base} theme="dark" themeId="default" themeVars={{}} width={200} />,
    );
    expect(container.querySelector("iframe")).toBeTruthy();
    expect(screen.queryByTestId("graph-component")).toBeNull(); // never the live runtime-loader path
  });
});
