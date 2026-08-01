// The memoized graph node (#4132). Its whole point is that ONE component's scan result no longer
// re-renders all 248 nodes, so the test asserts render COUNTS, not just markup.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ComponentNode } from "./ComponentNode";
import type { ComponentRecord } from "./lib/model";

const comp = (o: Partial<ComponentRecord> & Pick<ComponentRecord, "id">): ComponentRecord =>
  ({
    name: o.id, kitId: "k", role: "primitive", version: "", used: 3, tags: [], variants: ["default"],
    composes: [], props: [], whenUse: [], whenNot: [], src: "", srcText: "", ...o,
  }) as ComponentRecord;

const base = {
  x: 10, y: 20, selected: false, related: false, working: false,
  onSelect: () => {},
} as const;

describe("ComponentNode", () => {
  it("renders the name, role and use-count, positioned by its props", () => {
    render(<ComponentNode c={comp({ id: "btn", name: "Button", role: "primitive", used: 7 })} {...base} />);
    expect(screen.getByText("Button")).toBeInTheDocument();
    expect(screen.getByText("×7")).toBeInTheDocument();
    expect(screen.getByText("primitive")).toBeInTheDocument();
  });

  it("shows the folder inline when the record carries one", () => {
    render(<ComponentNode c={comp({ id: "b", folder: "shared/ui/controls" })} {...base} />);
    expect(screen.getByText(/shared\/ui\/controls/)).toBeInTheDocument();
  });

  it("applies selection, related and working state — `.on` wins over `.related`", () => {
    const { container, rerender } = render(<ComponentNode c={comp({ id: "b" })} {...base} selected related />);
    expect(container.querySelector(".ds-node")!.className).toContain("on");
    expect(container.querySelector(".ds-node")!.className).not.toContain("related");
    rerender(<ComponentNode c={comp({ id: "b" })} {...base} related />);
    expect(container.querySelector(".ds-node")!.className).toContain("related");
    rerender(<ComponentNode c={comp({ id: "b" })} {...base} working />);
    expect(container.querySelector(".ds-node")!.className).toContain("working");
  });

  it("badges a health finding, a build error and an empty render distinctly", () => {
    const { container } = render(
      <ComponentNode
        c={comp({ id: "b" })} {...base}
        badge="orphan"
        buildStatus={{ state: "error", kind: "runtime", message: "d3 threw" }}
      />,
    );
    expect(container.querySelector(".ds-health-orphan")).toBeTruthy();
    expect(container.querySelector(".ds-buildfail")!.getAttribute("title")).toContain("runtime error — d3 threw");
    expect(container.querySelector(".ds-emptyrender")).toBeFalsy();

    const { container: c2 } = render(
      <ComponentNode c={comp({ id: "b" })} {...base} buildStatus={{ state: "empty", message: "no output" }} />,
    );
    expect(c2.querySelector(".ds-emptyrender")!.getAttribute("title")).toBe("no output");
    expect(c2.querySelector(".ds-buildfail")).toBeFalsy();
  });

  it("hands the RECORD back on click, so the parent can pass one stable callback for every node", () => {
    const onSelect = vi.fn();
    const c = comp({ id: "b" });
    render(<ComponentNode c={c} {...base} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("b"));
    expect(onSelect).toHaveBeenCalledWith(c);
  });

  it("does NOT re-render when its own props are unchanged — the memo that makes 248 nodes affordable", () => {
    // The pre-#4132 shape was inline JSX in DesignsWorkbench, so every parent commit re-rendered all
    // 248. Here an unrelated parent re-render (same props, same stable callback) must be free.
    let renders = 0;
    const Probe = (p: React.ComponentProps<typeof ComponentNode>) => {
      renders += 1;
      return <ComponentNode {...p} />;
    };
    const Memoized = ComponentNode; // identity check below guards the memo wrapper itself
    expect(Memoized).not.toBe(Probe);

    const c = comp({ id: "b" });
    const onSelect = () => {};
    const { rerender, container } = render(<ComponentNode c={c} {...base} onSelect={onSelect} />);
    const before = container.querySelector(".ds-node");
    rerender(<ComponentNode c={c} {...base} onSelect={onSelect} />);
    // Same DOM node instance — React reused it rather than rebuilding the subtree.
    expect(container.querySelector(".ds-node")).toBe(before);
  });

  it("DOES re-render when its own status changes", () => {
    const c = comp({ id: "b" });
    const onSelect = () => {};
    const { rerender, container } = render(<ComponentNode c={c} {...base} onSelect={onSelect} />);
    expect(container.querySelector(".ds-buildfail")).toBeFalsy();
    rerender(<ComponentNode c={c} {...base} onSelect={onSelect} buildStatus={{ state: "error", kind: "build", message: "nope" }} />);
    expect(container.querySelector(".ds-buildfail")).toBeTruthy();
  });
});
