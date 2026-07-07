import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { KeyValueList } from "./KeyValueList";

const ITEMS = [
  { k: "repo", v: "base-studio-code" },
  { k: "branch", v: "develop" },
  { k: "issues", v: 42 },
];

describe("KeyValueList (#2475)", () => {
  it("renders one label : value row per item, in order", () => {
    render(<KeyValueList items={ITEMS} />);
    for (const label of ["repo", "branch", "issues"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("base-studio-code")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("lays the rows on a labelWidth · 1fr grid", () => {
    const { container } = render(<KeyValueList items={ITEMS} labelWidth={90} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.display).toBe("grid");
    expect(root.style.gridTemplateColumns).toBe("90px 1fr");
  });

  it("mono renders values (not labels) in the mono font", () => {
    render(<KeyValueList items={[{ k: "path", v: "/usr/bin/bsc" }]} mono />);
    const value = screen.getByText("/usr/bin/bsc");
    expect(value.style.fontFamily).toBe("var(--mono)");
  });

  it("loading keeps the labels but skeletons every value (#2302)", () => {
    const { container } = render(<KeyValueList items={ITEMS} loading />);
    for (const label of ["repo", "branch", "issues"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText("base-studio-code")).toBeNull();
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBe(ITEMS.length);
  });

  it("renders nothing for an empty record", () => {
    const { container } = render(<KeyValueList items={[]} />);
    expect((container.firstElementChild as HTMLElement).childElementCount).toBe(0);
  });
});
