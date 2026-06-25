import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { PreviewFrame } from "./PreviewFrame";

describe("PreviewFrame", () => {
  it("renders nothing without a srcDoc", () => {
    const { container } = render(<PreviewFrame srcDoc={null} />);
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("renders a sandboxed iframe carrying the srcdoc", () => {
    const { container } = render(<PreviewFrame srcDoc="<html><body>hi</body></html>" />);
    const f = container.querySelector("iframe")!;
    expect(f.getAttribute("sandbox")).toBe("allow-scripts");
    expect(f.getAttribute("srcdoc")).toContain("<body>hi</body>");
  });

  it("relays {__preview} error messages from the preview iframe to onStatus", () => {
    const onStatus = vi.fn();
    const { container } = render(<PreviewFrame srcDoc="<html></html>" onStatus={onStatus} />);
    const frame = container.querySelector("iframe")!;
    window.dispatchEvent(new MessageEvent("message", { data: { __preview: "error", message: "boom" }, source: frame.contentWindow }));
    expect(onStatus).toHaveBeenCalledWith({ status: "error", message: "boom" });
  });

  it("relays the ready signal from the preview iframe", () => {
    const onStatus = vi.fn();
    const { container } = render(<PreviewFrame srcDoc="<html></html>" onStatus={onStatus} />);
    const frame = container.querySelector("iframe")!;
    window.dispatchEvent(new MessageEvent("message", { data: { __preview: "ready" }, source: frame.contentWindow }));
    expect(onStatus).toHaveBeenCalledWith({ status: "ready" });
  });

  it("ignores a {__preview} message that isn't from the preview iframe (#1011)", () => {
    const onStatus = vi.fn();
    render(<PreviewFrame srcDoc="<html></html>" onStatus={onStatus} />);
    // No `source` ⇒ a different window (e.g. another frame / the opener). Must be dropped.
    window.dispatchEvent(new MessageEvent("message", { data: { __preview: "ready" } }));
    expect(onStatus).not.toHaveBeenCalled();
  });
});
