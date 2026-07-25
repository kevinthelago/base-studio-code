// #3627 regression — the Design Studio's background loops (activity poll + preview scan) must pause when
// the Studio is HIDDEN. KeptMountedPage keeps DesignsWorkbench mounted (display:none) after the first
// visit and a hidden child's effects keep firing, so an unconditional `useUiActivity(true)` (the pre-#3627
// bug) kept polling `bsc logs tail ui` against the Rust host forever. Both loops are gated on the one
// `designStudioVisible` flag; this asserts they receive it.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { useAppStore } from "@/store";

// esbuild-wasm can't run under jsdom — mock the bundler (mirrors DesignsWorkbench.test.tsx #2824).
vi.mock("@/shared/lib/preview/componentBundle", () => ({
  bundleComponent: vi.fn().mockResolvedValue("/*bundle*/"),
  buildComponentSrcDoc: (js: string) => `<!doctype html><html><body>${js}</body></html>`,
  COMPONENT_IMPORTMAP: { react: "https://esm.sh/react" },
  COMPONENT_EXTERNALS: ["react"],
}));

// Spy the two background loops so we can read the visibility flag each was handed. `vi.hoisted` so the
// spies exist before `vi.mock` is hoisted above the imports.
const { uiSpy, scanSpy } = vi.hoisted(() => ({ uiSpy: vi.fn(), scanSpy: vi.fn() }));
vi.mock("./lib/uiActivity", () => ({ useUiActivity: uiSpy }));
vi.mock("./lib/useComponentScan", () => ({ useComponentScan: scanSpy }));

import { DesignsWorkbench } from "./DesignsWorkbench";
import { REACT_UI_KIT, REACT_UI_COMPONENTS } from "./lib/reactUiKit";
import { SEED_THEMES } from "./lib/themes";

beforeEach(() => {
  uiSpy.mockClear();
  scanSpy.mockClear();
  useAppStore.setState({
    components: REACT_UI_COMPONENTS,
    kits: [REACT_UI_KIT],
    kitThemes: SEED_THEMES,
    aiFocusedId: null,
    designsKitId: "",
    designsCompId: null,
  });
});

describe("DesignsWorkbench visibility gating (#3627)", () => {
  it("polls activity + scans previews when the Studio is the visible page", () => {
    useAppStore.setState({ activeWorkspace: "projects", projectsPageMode: "designs" });
    render(<DesignsWorkbench />);
    expect(uiSpy).toHaveBeenCalledWith(true);
    expect(scanSpy).toHaveBeenCalledWith(true, expect.anything(), undefined, expect.anything());
  });

  it("does NOT poll or scan while hidden — the KeptMountedPage leak the bug caused", () => {
    useAppStore.setState({ activeWorkspace: "console", projectsPageMode: "designs" });
    render(<DesignsWorkbench />);
    expect(uiSpy).toHaveBeenCalledWith(false);
    expect(scanSpy).toHaveBeenCalledWith(false, expect.anything(), undefined, expect.anything());
  });

  it("hidden on the projects workspace when it's showing a non-designs page (e.g. Teams)", () => {
    useAppStore.setState({ activeWorkspace: "projects", projectsPageMode: "teams" });
    render(<DesignsWorkbench />);
    expect(uiSpy).toHaveBeenCalledWith(false);
    expect(scanSpy).toHaveBeenCalledWith(false, expect.anything(), undefined, expect.anything());
  });
});
