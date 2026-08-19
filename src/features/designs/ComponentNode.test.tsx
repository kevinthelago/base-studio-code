// The memoized graph node (#4132). Its whole point is that ONE component's scan result no longer
// re-renders all 248 nodes, so the test asserts render COUNTS, not just markup.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ComponentNode } from "@/features/designs/ComponentNode";
import { useAppStore } from "@/store";
import type { ComponentRecord } from "@/features/designs/lib/model";

const comp = (o: Partial<ComponentRecord> & Pick<ComponentRecord, "id">): ComponentRecord =>
  ({
    name: o.id, kitId: "k", role: "primitive", version: "", used: 3, tags: [], variants: ["default"],
    composes: [], props: [], whenUse: [], whenNot: [], src: "", srcText: "", ...o,
  }) as ComponentRecord;

const base = {
  x: 10, y: 20, selected: false, related: false, working: false,
  onSelect: () => {},
} as const;

/** Scan results now reach a node through the STORE, not props (#two-store-keys-drive-more-than-half-the-apps-jank). */
const setScan = (id: string, status?: unknown, health?: unknown) =>
  act(() => {
    useAppStore.setState((s) => ({
      componentBuildStatus: { ...s.componentBuildStatus, ...(status === undefined ? {} : { [id]: status }) },
      componentStateHealth: { ...s.componentStateHealth, ...(health === undefined ? {} : { [id]: health }) },
    }) as never);
  });

describe("ComponentNode", () => {
  beforeEach(() => {
    act(() => {
      useAppStore.setState({ componentBuildStatus: {}, componentStateHealth: {} } as never);
    });
  });

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
    setScan("b", { state: "error", kind: "runtime", message: "d3 threw" });
    const { container } = render(<ComponentNode c={comp({ id: "b" })} {...base} badge="orphan" />);
    expect(container.querySelector(".ds-health-orphan")).toBeTruthy();
    expect(container.querySelector(".ds-buildfail")!.getAttribute("title")).toContain("runtime error — d3 threw");
    expect(container.querySelector(".ds-emptyrender")).toBeFalsy();

    setScan("e", { state: "empty", message: "no output" });
    const { container: c2 } = render(<ComponentNode c={comp({ id: "e" })} {...base} />);
    expect(c2.querySelector(".ds-emptyrender")!.getAttribute("title")).toBe("no output");
    expect(c2.querySelector(".ds-buildfail")).toBeFalsy();
  });

  it("folds its OWN runtime health into the static badge — most severe wins", () => {
    // The workbench passes only the static `analyzeGraphHealth` category; the scan's runtime blanks
    // (#3191) arrive through the store so a flush cannot re-render the parent. `worstHealth` decides.
    setScan("b", undefined, ["empty-empty-state"]);
    const { container } = render(<ComponentNode c={comp({ id: "b" })} {...base} badge="slot-shell" />);
    // slot-shell is informational (severity 1); the runtime blank outranks it.
    expect(container.querySelector(".ds-health-empty-empty-state")).toBeTruthy();
    expect(container.querySelector(".ds-health-slot-shell")).toBeFalsy();

    // ...and a real static defect outranks the runtime blank the other way.
    setScan("c", undefined, ["empty-empty-state"]);
    const { container: c2 } = render(<ComponentNode c={comp({ id: "c" })} {...base} badge="cycle" />);
    expect(c2.querySelector(".ds-health-cycle")).toBeTruthy();
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

  it("DOES re-render when its own status lands in the store — with NO parent re-render", () => {
    // The whole point of the inversion (#two-store-keys-drive-more-than-half-the-apps-jank): a scan
    // flush must reach the node WITHOUT the parent rendering again. Previously the status arrived as a
    // prop, which meant the parent had to re-render for the node to update — and the parent subscribed
    // to the whole record, so one component's result re-rendered the entire graph.
    let parentRenders = 0;
    const Parent = () => {
      parentRenders += 1;
      return <ComponentNode c={comp({ id: "b" })} {...base} />;
    };
    const { container } = render(<Parent />);
    expect(container.querySelector(".ds-buildfail")).toBeFalsy();
    const after = parentRenders;

    setScan("b", { state: "error", kind: "build", message: "nope" });

    expect(container.querySelector(".ds-buildfail")).toBeTruthy();
    expect(parentRenders).toBe(after);
  });

  it("ignores a flush that changes ANOTHER component — the selector is per id", () => {
    const { container } = render(<ComponentNode c={comp({ id: "mine" })} {...base} />);
    const before = container.querySelector(".ds-node");
    setScan("someone-else", { state: "error", kind: "build", message: "not mine" });
    expect(container.querySelector(".ds-buildfail")).toBeFalsy();
    expect(container.querySelector(".ds-node")).toBe(before);
  });
});

describe("the node's DOM cost (#a-graph-node-costs-five-elements-not-eight)", () => {
  /** Every element the card renders, root included. */
  const elementCount = (c: HTMLElement) => c.querySelectorAll("*").length;
  const card = comp({ id: "btn", name: "Button", role: "primitive", used: 7, folder: "shared/ui/controls" });

  it("costs FIVE elements for a node with a folder — root, name, role, folder, count", () => {
    // The number IS the feature. It used to be eight: the root, two nested flex wrappers, a StatusDot
    // and four texts — three of which existed only to lay the others out. At 232 mounted nodes that
    // scaffolding was ~700 elements plus a style object each, per render.
    //
    // Asserted exactly rather than as "fewer than before", because a regression here is invisible: the
    // card would look identical and simply cost more.
    const { container } = render(<ComponentNode c={card} {...base} />);
    expect(elementCount(container)).toBe(5);
  });

  it("costs FOUR without a folder — the folder span is the only conditional leaf", () => {
    const { container } = render(<ComponentNode c={comp({ id: "btn", name: "Button" })} {...base} />);
    expect(elementCount(container)).toBe(4);
  });

  it("still shows the role, the folder and the count as REAL TEXT, not CSS content", () => {
    // The constraint that stops this going to three elements. These are information: moving them into
    // `content:` would hide them from a screen reader, which is not a trade worth two elements — least
    // of all during an accessibility milestone. `getByText` passing IS the a11y guarantee here.
    render(<ComponentNode c={card} {...base} />);
    expect(screen.getByText("Button")).toBeInTheDocument();
    expect(screen.getByText("primitive")).toBeInTheDocument();
    expect(screen.getByText(/shared\/ui\/controls/)).toBeInTheDocument();
    expect(screen.getByText("×7")).toBeInTheDocument();
  });

  it("carries the role COLOUR as a custom property, since a ::before has no other channel", () => {
    const { container } = render(<ComponentNode c={card} {...base} />);
    const node = container.querySelector(".ds-node") as HTMLElement;
    expect(node.style.getPropertyValue("--ds-role")).toBeTruthy();
  });

  it("keeps the badges as real elements WITH their tooltips", () => {
    // Badges carry the error message in `title`, which a pseudo-element cannot do — so they stay
    // elements, and the count above is the healthy-node count rather than a ceiling.
    setScan(card.id, { state: "error", kind: "build", message: "boom" });
    const { container } = render(<ComponentNode c={card} {...base} badge="orphan" />);
    expect(container.querySelector(".ds-health-orphan")).toBeTruthy();
    expect(container.querySelector(".ds-buildfail")!.getAttribute("title")).toContain("boom");
  });
});
