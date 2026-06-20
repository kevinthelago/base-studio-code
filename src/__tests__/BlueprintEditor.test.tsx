import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { BlueprintEditorView } from "../screens/planner/BlueprintEditor";
import { mkStageSection } from "../screens/planner/blueprintEdit";
import type { BlueprintSection } from "../screens/planner/blueprints";

/** A controlled harness so edits flow through onChange like the real page. */
function Harness({ initial, onChangeSpy }: { initial: BlueprintSection[]; onChangeSpy?: (s: BlueprintSection[]) => void }) {
  const [sections, setSections] = useState(initial);
  const [sel, setSel] = useState<string | null>(initial[0]?.uid ?? null);
  return (
    <BlueprintEditorView
      sections={sections}
      selectedUid={sel}
      onSelect={setSel}
      onChange={(s) => { setSections(s); onChangeSpy?.(s); }}
    />
  );
}

const base = () => [mkStageSection("context"), mkStageSection("ui"), mkStageSection("structure")];

describe("BlueprintEditorView (#609 slice 3)", () => {
  it("renders the stage rail with every stage", () => {
    render(<Harness initial={base()} />);
    expect(screen.getByText("Stage flow")).toBeInTheDocument();
    expect(screen.getByText("Context")).toBeInTheDocument();
    expect(screen.getByText("UI")).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
  });

  it("editing the prompt flows through onChange", () => {
    const spy = vi.fn();
    render(<Harness initial={base()} onChangeSpy={spy} />);
    const ta = screen.getByPlaceholderText(/Instructions for the planning agent/i);
    fireEvent.change(ta, { target: { value: "Write the pitch." } });
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[spy.mock.calls.length - 1][0][0].prompt).toBe("Write the pitch.");
  });

  it("changes the output disposition", () => {
    const spy = vi.fn();
    render(<Harness initial={base()} onChangeSpy={spy} />);
    // context defaults to "knowledge"; pick "Scratch"
    fireEvent.click(screen.getByText("Scratch"));
    expect(spy.mock.calls[spy.mock.calls.length - 1][0][0].output).toBe("scratch");
  });

  it("adds a stage from the palette", () => {
    render(<Harness initial={base()} />);
    fireEvent.click(screen.getByRole("button", { name: /\+ Add stage/i }));
    // palette shows kinds; pick Security
    fireEvent.click(screen.getByRole("button", { name: /Security/i }));
    expect(within(screen.getByText("Stage flow").closest(".rail-stages")!).getByText("Security")).toBeInTheDocument();
  });

  it("shows the upstream ribbon when provided", () => {
    render(
      <BlueprintEditorView sections={base()} selectedUid={null} onSelect={() => {}} onChange={() => {}}
        ribbon={{ author: "studio", label: "r8", summary: "adds Observability" }} onResolveRibbon={() => {}} />,
    );
    expect(screen.getByText(/shipped/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Review changes/i })).toBeInTheDocument();
  });
});
