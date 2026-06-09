import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { PreviewFrame } from "../screens/projects/PreviewFrame";

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

  it("relays {__preview} error messages to onStatus", () => {
    const onStatus = vi.fn();
    render(<PreviewFrame srcDoc="<html></html>" onStatus={onStatus} />);
    window.dispatchEvent(new MessageEvent("message", { data: { __preview: "error", message: "boom" } }));
    expect(onStatus).toHaveBeenCalledWith({ status: "error", message: "boom" });
  });

  it("relays the ready signal", () => {
    const onStatus = vi.fn();
    render(<PreviewFrame srcDoc="<html></html>" onStatus={onStatus} />);
    window.dispatchEvent(new MessageEvent("message", { data: { __preview: "ready" } }));
    expect(onStatus).toHaveBeenCalledWith({ status: "ready" });
  });
});
