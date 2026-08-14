// The frame's REGISTRY contract (#3437 + the navigate-ack fix).
//
// The build effect used to return early on a refused build without touching the iframe or the registry,
// so `registerPreviewFrame` kept naming the LAST component that built. Everything downstream then read a
// mount that was no longer on screen: `bsc debug frames` reported it, and `bsc navigate` acked it — the
// designer saw `navigate plan-body-deployment` succeed while the preview still showed `ui-tab-bar`.
//
// These tests drive the REAL component. They deliberately do not need esbuild: the refused-build path is
// synchronous (`componentPreviewFiles` returns null), which is exactly the path that was silent.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
// NOTE: the feature barrel is imported FIRST on purpose. `lib/libraryModules` reaches the algorithms
// BARREL, and pulling this component in through a different entry order re-enters that module graph
// mid-initialisation ("algoNodeLookup is not a function") — a known cycle, not a defect in this test.
import "@/features/designs";
import { useAppStore } from "@/store";
import { ComponentPreviewFrame } from "./ComponentPreviewFrame";
import { mountedPreviewFrames, resetPreviewFrames } from "./lib/previewRegistry";
import { recordPreviewError, clearPreviewError } from "./lib/componentBridge";
import type { ComponentRecord } from "./lib/model";

// The bridge shells out to `bsc`; only WHETHER the two error verbs were called matters here. PARTIAL
// mock — the module is the Studio's whole `bsc` surface and the frame's siblings import the rest of it,
// so replacing it wholesale breaks unrelated modules at import time.
vi.mock("./lib/componentBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/componentBridge")>()),
  recordPreviewError: vi.fn(async () => {}),
  clearPreviewError: vi.fn(async () => {}),
}));

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

// #45/#60: the error record is written on a failed render and must be RETIRED on a successful one.
// Without the success half, a component fixed by a change elsewhere — a shared dependency, or a resolver
// bug in the preview itself — kept its `render-error` finding forever, and `bsc ui doctor` reported a
// failure that a live `bsc shot preview` disproved. Measured right after the barrel-resolution fix:
// components that mounted fine still carried 54 findings between them.
describe("ComponentPreviewFrame — a render that succeeds retires the recorded error", () => {
  beforeEach(() => {
    resetPreviewFrames();
    vi.mocked(clearPreviewError).mockClear();
    vi.mocked(recordPreviewError).mockClear();
    useAppStore.setState({ kits: [{ id: "test-kit", name: "Test" }], components: [] } as never);
  });
  afterEach(() => cleanup());

  /** Post a preview signal AS the frame's own iframe, which is the only source it accepts (#2908). */
  const post = (container: HTMLElement, data: unknown) => {
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent("message", { data, source: iframe.contentWindow }));
  };

  it("REPRODUCER: clears the recorded error when the preview reports ready", async () => {
    const { container } = render(<ComponentPreviewFrame comp={snippet("achievements")} {...frameProps} />);
    post(container, { __preview: "ready" });
    await waitFor(() => expect(vi.mocked(clearPreviewError)).toHaveBeenCalledWith("achievements"));
    expect(vi.mocked(recordPreviewError)).not.toHaveBeenCalled();
  });

  it("still RECORDS on a runtime error, and does not clear", async () => {
    const { container } = render(<ComponentPreviewFrame comp={snippet("achievements")} {...frameProps} />);
    post(container, { __preview: "error", message: "boom" });
    await waitFor(() => expect(vi.mocked(recordPreviewError)).toHaveBeenCalledWith("achievements", "boom"));
    expect(vi.mocked(clearPreviewError)).not.toHaveBeenCalled();
  });

  it("ignores a ready from ANOTHER window, so a concurrent scan probe cannot clear this component", () => {
    render(<ComponentPreviewFrame comp={snippet("achievements")} {...frameProps} />);
    // #2908: the on-visit scan runs its own hidden probe iframes; their messages must not be honoured.
    window.dispatchEvent(new MessageEvent("message", { data: { __preview: "ready" }, source: window }));
    expect(vi.mocked(clearPreviewError)).not.toHaveBeenCalled();
  });
});
