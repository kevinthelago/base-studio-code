import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Button } from "./Button";

describe("Button", () => {
  it("renders the base .btn class and the label", () => {
    render(<Button>Save</Button>);
    const b = screen.getByRole("button", { name: "Save" });
    expect(b.className).toBe("btn");
    expect(b.getAttribute("type")).toBe("button");
  });

  it("composes variant / danger / size into the .btn modifier classes", () => {
    render(<Button variant="primary" size="sm">Go</Button>);
    expect(screen.getByText("Go").className).toBe("btn primary sm");
    render(<Button variant="ghost" danger>Del</Button>);
    expect(screen.getByText("Del").className).toBe("btn ghost danger");
  });

  it("passes through onClick, disabled, and a caller className", () => {
    const onClick = vi.fn();
    render(<Button className="x" onClick={onClick}>Hit</Button>);
    const b = screen.getByText("Hit");
    expect(b.className).toBe("btn x");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("honors an explicit type (e.g. submit)", () => {
    render(<Button type="submit">Send</Button>);
    expect(screen.getByText("Send").getAttribute("type")).toBe("submit");
  });
});
