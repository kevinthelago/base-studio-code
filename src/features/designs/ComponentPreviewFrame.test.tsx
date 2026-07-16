import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";

// The live preview builds with esbuild-wasm (can't run under jsdom); mock the bundler so the frame mounts
// without the wasm runtime. These tests exercise the PARENT side of the #3190 gesture forwarding — the
// message handler that turns the iframe's postMessages (and the window's own moves, once a drag leaves the
// iframe) into onPreviewPan/onPreviewZoom calls.
vi.mock("@/shared/lib/preview/componentBundle", () => ({
  bundleComponent: vi.fn().mockResolvedValue("/*bundle*/"),
  buildComponentSrcDoc: (js: string) => `<!doctype html><html><body>${js}</body></html>`,
  COMPONENT_IMPORTMAP: { react: "https://esm.sh/react" },
  COMPONENT_EXTERNALS: ["react"],
}));
import { ComponentPreviewFrame } from "./ComponentPreviewFrame";
import { SEED_COMPONENTS } from "./lib/seed";

const comp = SEED_COMPONENTS[0];
const post = (data: unknown) => act(() => { window.dispatchEvent(new MessageEvent("message", { data })); });
const mouse = (type: string, screenX: number, screenY: number) =>
  act(() => { window.dispatchEvent(new MouseEvent(type, { screenX, screenY, bubbles: true })); });

beforeEach(() => cleanup());

describe("ComponentPreviewFrame — forwarded gesture handling (#3190)", () => {
  it("turns forwarded panstart/panmove into screen-delta onPreviewPan calls", () => {
    const onPreviewPan = vi.fn();
    render(<ComponentPreviewFrame comp={comp} theme="dark" themeId="t" themeVars={{}} width={640} height={440} onPreviewPan={onPreviewPan} />);

    post({ __preview: "panstart", x: 100, y: 100 });
    post({ __preview: "panmove", x: 112, y: 106 });   // over the frame → iframe-reported
    expect(onPreviewPan).toHaveBeenLastCalledWith(12, 6);
    post({ __preview: "panmove", x: 120, y: 110 });   // deltas accumulate from the last position
    expect(onPreviewPan).toHaveBeenLastCalledWith(8, 4);
    post({ __preview: "panend" });
    post({ __preview: "panmove", x: 999, y: 999 });    // after end → ignored (no in-flight drag)
    expect(onPreviewPan).toHaveBeenCalledTimes(2);
  });

  it("keeps panning over the GUTTER: after panstart, window moves drive the pan, mouseup ends it", () => {
    const onPreviewPan = vi.fn();
    render(<ComponentPreviewFrame comp={comp} theme="dark" themeId="t" themeVars={{}} width={640} height={440} onPreviewPan={onPreviewPan} />);

    post({ __preview: "panstart", x: 200, y: 200 });   // arms the window continuation
    mouse("mousemove", 215, 208);                        // cursor now over the gutter → window-reported
    expect(onPreviewPan).toHaveBeenLastCalledWith(15, 8);
    mouse("mousemove", 210, 210);                        // continues from the last position (−5, +2)
    expect(onPreviewPan).toHaveBeenLastCalledWith(-5, 2);
    mouse("mouseup", 210, 210);                          // released over the gutter → ends the drag
    onPreviewPan.mockClear();
    mouse("mousemove", 400, 400);                        // no in-flight drag → nothing
    expect(onPreviewPan).not.toHaveBeenCalled();
  });

  it("composes iframe- and window-reported moves across the boundary via one screen-space accumulator", () => {
    const onPreviewPan = vi.fn();
    render(<ComponentPreviewFrame comp={comp} theme="dark" themeId="t" themeVars={{}} width={640} height={440} onPreviewPan={onPreviewPan} />);

    post({ __preview: "panstart", x: 50, y: 50 });
    post({ __preview: "panmove", x: 60, y: 55 });   // over frame: +10, +5
    expect(onPreviewPan).toHaveBeenLastCalledWith(10, 5);
    mouse("mousemove", 75, 65);                       // crossed to gutter: +15, +10 from the SAME last pos
    expect(onPreviewPan).toHaveBeenLastCalledWith(15, 10);
    post({ __preview: "panmove", x: 70, y: 70 });   // crossed back over frame: −5, +5
    expect(onPreviewPan).toHaveBeenLastCalledWith(-5, 5);
  });

  it("resolves a zoom fraction against the iframe's real rect into page coords for onPreviewZoom", () => {
    const onPreviewZoom = vi.fn();
    const { container } = render(<ComponentPreviewFrame comp={comp} theme="dark" themeId="t" themeVars={{}} width={640} height={440} onPreviewZoom={onPreviewZoom} />);
    // jsdom has no layout, so stub the iframe's rendered rect; the handler maps (fx,fy) → page coords.
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    iframe.getBoundingClientRect = () => ({ left: 100, top: 50, width: 200, height: 100, right: 300, bottom: 150, x: 100, y: 50, toJSON: () => ({}) });
    post({ __preview: "zoom", dy: -120, fx: 0.5, fy: 0.25 });
    // pageX = 100 + 0.5*200 = 200 ; pageY = 50 + 0.25*100 = 75.
    expect(onPreviewZoom).toHaveBeenCalledWith(-120, 200, 75);
  });
});
