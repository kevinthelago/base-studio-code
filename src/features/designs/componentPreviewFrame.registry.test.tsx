// The frame's REGISTRY contract (#3437 + the navigate-ack fix).
//
// The build effect used to return early on a refused build without touching the iframe or the registry,
// so `registerPreviewFrame` kept naming the LAST component that built. Everything downstream then read a
// mount that was no longer on screen: `bsc debug frames` reported it, and `bsc navigate` acked it — the
// designer saw `navigate plan-body-deployment` succeed while the preview still showed `ui-tab-bar`.
//
// These tests drive the REAL component. They deliberately do not need esbuild: the refused-build path is
// synchronous (`componentPreviewFiles` returns null), which is exactly the path that was silent.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
// NOTE: the feature barrel is imported FIRST on purpose. `lib/libraryModules` reaches the algorithms
// BARREL, and pulling this component in through a different entry order re-enters that module graph
// mid-initialisation ("algoNodeLookup is not a function") — a known cycle, not a defect in this test.
import "@/features/designs";
import { useAppStore } from "@/store";
import { ComponentPreviewFrame } from "./ComponentPreviewFrame";
import { mountedPreviewFrames, resetPreviewFrames } from "./lib/previewRegistry";
import type { ComponentRecord } from "./lib/model";

/** A record whose `srcText` is a usage SNIPPET, not a runnable module — `componentPreviewFiles` returns
 *  null for it, which is the refused-build path. */
const snippet = (id: string): ComponentRecord => ({
  id, name: id, kitId: "test-kit", role: "primitive", version: "1.0.0", used: 0,
  tags: [], variants: ["default"], composes: [], props: [], whenUse: [], whenNot: [],
  src: `test-kit/${id}.tsx`, srcText: `<${id} label="hi" />`,
});

const frameProps = { theme: "dark" as const, themeId: "default", themeVars: {}, width: 200 };

describe("ComponentPreviewFrame — the registry never names a component that is not on screen", () => {
  beforeEach(() => {
    resetPreviewFrames();
    useAppStore.setState({ kits: [{ id: "test-kit", name: "Test" }], components: [] } as never);
  });
  afterEach(() => cleanup());

  it("registers a REFUSED build under the component it refused, with the reason", async () => {
    render(<ComponentPreviewFrame comp={snippet("achievements")} {...frameProps} />);

    await waitFor(() => expect(mountedPreviewFrames()).toHaveLength(1));
    const [f] = mountedPreviewFrames();
    expect(f.component).toBe("achievements");
    expect(f.status).toBe("error");
    expect(f.error).toContain("no implementation source yet");
  });

  it("REPRODUCER: switching to a component that cannot build stops reporting the previous one", async () => {
    const { rerender } = render(<ComponentPreviewFrame comp={snippet("ui-tab-bar")} {...frameProps} />);
    await waitFor(() => expect(mountedPreviewFrames()).toHaveLength(1));

    rerender(<ComponentPreviewFrame comp={snippet("plan-body-deployment")} {...frameProps} />);
    await waitFor(() => expect(mountedPreviewFrames()[0]?.component).toBe("plan-body-deployment"));
    // The old entry is REPLACED, not accumulated — one frame, one truth.
    expect(mountedPreviewFrames()).toHaveLength(1);
    expect(mountedPreviewFrames().map((f) => f.component)).not.toContain("ui-tab-bar");
  });

  it("leaves nothing of the previous component rendered underneath the error overlay", async () => {
    const { container, rerender } = render(<ComponentPreviewFrame comp={snippet("a")} {...frameProps} />);
    const iframe = container.querySelector("iframe")!;
    iframe.srcdoc = "<html><body>the PREVIOUS component</body></html>";

    rerender(<ComponentPreviewFrame comp={snippet("b")} {...frameProps} />);
    // A capture that photographs the iframe must not find the component that is no longer selected.
    await waitFor(() => expect(iframe.srcdoc).toBe(""));
  });
});
