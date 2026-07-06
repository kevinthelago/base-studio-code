import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModalCard } from "./ModalCard";

const scrim = (c: HTMLElement) => c.querySelector(".modal-scrim") as HTMLElement;

describe("ModalCard (#2420)", () => {
  it("renders the titled head, body, and foot", () => {
    render(
      <ModalCard title="Import from gist" sub="Pull a shared blueprint" icon="↓" onClose={() => {}}
        foot={<button>Resolve</button>}>
        <div>body content</div>
      </ModalCard>,
    );
    expect(screen.getByRole("dialog", { name: "Import from gist" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Import from gist" })).toBeTruthy();
    expect(screen.getByText("Pull a shared blueprint")).toBeTruthy();
    expect(screen.getByText("↓")).toBeTruthy();
    expect(screen.getByText("body content")).toBeTruthy();
    expect(screen.getByText("Resolve")).toBeTruthy();
  });

  it("omits the foot row and icon when not provided", () => {
    const { container } = render(<ModalCard title="Plain" onClose={() => {}}><div>x</div></ModalCard>);
    expect(container.querySelector(".modal-foot")).toBeNull();
    expect(container.querySelector(".modal-head")).toBeTruthy();
  });

  it("wires onClose to the head ✕ and the scrim Escape/overlay dismiss", () => {
    const onClose = vi.fn();
    const { container } = render(<ModalCard title="Share kit" onClose={onClose}><div>x</div></ModalCard>);
    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(scrim(container));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("busy disables the ✕ and suppresses scrim/Escape dismiss", () => {
    const onClose = vi.fn();
    const { container } = render(<ModalCard title="Downloading" onClose={onClose} busy><div>x</div></ModalCard>);
    const x = screen.getByRole("button", { name: "close" }) as HTMLButtonElement;
    expect(x.disabled).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.mouseDown(scrim(container));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("is non-dismissable (no ✕, no scrim dismiss) when onClose is omitted", () => {
    const { container } = render(<ModalCard title="Locked"><div>x</div></ModalCard>);
    expect(screen.queryByRole("button", { name: "close" })).toBeNull();
    fireEvent.mouseDown(scrim(container));
    expect(screen.getByText("x")).toBeTruthy();
  });

  it("renders headExtra inside the bordered head block and merges body/foot style overrides", () => {
    const { container } = render(
      <ModalCard title="Skills" onClose={() => {}}
        headExtra={<input aria-label="Search skills" />}
        bodyStyle={{ padding: 0 }}
        foot={<span>done</span>} footStyle={{ background: "var(--bg-canvas)" }}>
        <div>rows</div>
      </ModalCard>,
    );
    const head = container.querySelector(".modal-head") as HTMLElement;
    expect(head.contains(screen.getByLabelText("Search skills"))).toBe(true);
    expect((container.querySelector(".modal-body") as HTMLElement).style.padding).toBe("0px");
    expect((container.querySelector(".modal-foot") as HTMLElement).style.background).toBe("var(--bg-canvas)");
  });

  it("applies align=start + width to the tall-modal layout", () => {
    const { container } = render(
      <ModalCard title="Tall" onClose={() => {}} align="start" width={840} maxHeight="calc(100vh - 120px)"><div>x</div></ModalCard>,
    );
    expect(scrim(container).classList.contains("start")).toBe(true);
    const card = screen.getByRole("dialog") as HTMLElement;
    expect(card.style.width).toBe("840px");
    expect(card.style.maxHeight).toBe("calc(100vh - 120px)");
  });
});
