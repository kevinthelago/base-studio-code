import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BlueprintLibrary, BlueprintResetModal } from "../screens/planner/blueprints/BlueprintLibraryLegacy";
import { BUILTIN_ARCHETYPES } from "../screens/planner/data/shape";

const ARCHETYPE_IDS = Object.keys(BUILTIN_ARCHETYPES);
const FIRST_ID = ARCHETYPE_IDS[0];
const SECOND_ID = ARCHETYPE_IDS[1];

// ----------------------------------------------------------------
// BlueprintLibrary — main component
// ----------------------------------------------------------------
describe("BlueprintLibrary", () => {
  it("renders a card for every built-in archetype", () => {
    render(<BlueprintLibrary activeBlueprintId={null} onUse={vi.fn()} />);
    for (const id of ARCHETYPE_IDS) {
      expect(screen.getByTestId(`blueprint-card-${id}`)).toBeTruthy();
    }
  });

  it("renders a 'Use' button on every card", () => {
    render(<BlueprintLibrary activeBlueprintId={null} onUse={vi.fn()} />);
    for (const id of ARCHETYPE_IDS) {
      expect(screen.getByTestId(`blueprint-use-${id}`)).toBeTruthy();
    }
  });

  it("shows '✓ in use' badge on the active blueprint card", () => {
    render(<BlueprintLibrary activeBlueprintId={FIRST_ID} onUse={vi.fn()} />);
    expect(screen.getByTestId(`blueprint-badge-inuse-${FIRST_ID}`)).toBeTruthy();
    // No badge on other cards
    expect(screen.queryByTestId(`blueprint-badge-inuse-${SECOND_ID}`)).toBeNull();
  });

  it("does not show badge when no blueprint is active", () => {
    render(<BlueprintLibrary activeBlueprintId={null} onUse={vi.fn()} />);
    for (const id of ARCHETYPE_IDS) {
      expect(screen.queryByTestId(`blueprint-badge-inuse-${id}`)).toBeNull();
    }
  });

  it("calls onUse immediately when activeBlueprintId is null (first-time use)", () => {
    const onUse = vi.fn();
    render(<BlueprintLibrary activeBlueprintId={null} onUse={onUse} />);
    fireEvent.click(screen.getByTestId(`blueprint-use-${FIRST_ID}`));
    expect(onUse).toHaveBeenCalledWith(FIRST_ID);
  });

  it("does NOT call onUse immediately when activeBlueprintId is set (shows reset modal)", () => {
    const onUse = vi.fn();
    render(<BlueprintLibrary activeBlueprintId={FIRST_ID} onUse={onUse} />);
    // Click "Use" on a DIFFERENT blueprint
    fireEvent.click(screen.getByTestId(`blueprint-use-${SECOND_ID}`));
    // onUse should NOT have been called yet
    expect(onUse).not.toHaveBeenCalled();
    // Reset modal should be visible
    expect(screen.getByTestId("blueprint-reset-modal")).toBeTruthy();
  });

  it("does NOT call onUse when clicking 'Use' on the already-active blueprint", () => {
    const onUse = vi.fn();
    render(<BlueprintLibrary activeBlueprintId={FIRST_ID} onUse={onUse} />);
    // The Use button on the active card is disabled — click should not fire
    const useBtn = screen.getByTestId(`blueprint-use-${FIRST_ID}`) as HTMLButtonElement;
    expect(useBtn.disabled).toBe(true);
    fireEvent.click(useBtn);
    expect(onUse).not.toHaveBeenCalled();
  });

  it("opens the editor when a card is clicked", () => {
    render(<BlueprintLibrary activeBlueprintId={null} onUse={vi.fn()} />);
    fireEvent.click(screen.getByTestId(`blueprint-card-${FIRST_ID}`));
    expect(screen.getByTestId("blueprint-editor")).toBeTruthy();
    expect(screen.getByTestId(`blueprint-editor-use-${FIRST_ID}`)).toBeTruthy();
  });

  it("closes the editor when clicking the same card again", () => {
    render(<BlueprintLibrary activeBlueprintId={null} onUse={vi.fn()} />);
    fireEvent.click(screen.getByTestId(`blueprint-card-${FIRST_ID}`));
    expect(screen.getByTestId("blueprint-editor")).toBeTruthy();
    fireEvent.click(screen.getByTestId(`blueprint-card-${FIRST_ID}`));
    expect(screen.queryByTestId("blueprint-editor")).toBeNull();
  });

  it("renders 'publish to gist' as a secondary button in the editor (#670)", () => {
    render(<BlueprintLibrary activeBlueprintId={null} onUse={vi.fn()} />);
    fireEvent.click(screen.getByTestId(`blueprint-card-${FIRST_ID}`));
    // 'publish to gist' button should be present and NOT be the primary CTA
    const gistBtn = screen.getByTestId(`blueprint-editor-gist-${FIRST_ID}`);
    expect(gistBtn).toBeTruthy();
    // The primary/use button should be a separate element
    const useBtn = screen.getByTestId(`blueprint-editor-use-${FIRST_ID}`);
    expect(useBtn).toBeTruthy();
    expect(useBtn).not.toBe(gistBtn);
  });

  it("shows a close button when onClose is provided", () => {
    const onClose = vi.fn();
    render(<BlueprintLibrary activeBlueprintId={null} onUse={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("blueprint-library-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onUse on confirm in reset modal and closes modal", () => {
    const onUse = vi.fn();
    render(<BlueprintLibrary activeBlueprintId={FIRST_ID} onUse={onUse} />);
    fireEvent.click(screen.getByTestId(`blueprint-use-${SECOND_ID}`));
    expect(screen.getByTestId("blueprint-reset-modal")).toBeTruthy();
    fireEvent.click(screen.getByTestId("reset-modal-confirm"));
    expect(onUse).toHaveBeenCalledWith(SECOND_ID);
    expect(screen.queryByTestId("blueprint-reset-modal")).toBeNull();
  });

  it("closes reset modal on cancel without calling onUse", () => {
    const onUse = vi.fn();
    render(<BlueprintLibrary activeBlueprintId={FIRST_ID} onUse={onUse} />);
    fireEvent.click(screen.getByTestId(`blueprint-use-${SECOND_ID}`));
    fireEvent.click(screen.getByTestId("reset-modal-cancel"));
    expect(onUse).not.toHaveBeenCalled();
    expect(screen.queryByTestId("blueprint-reset-modal")).toBeNull();
  });

  it("closes reset modal on export without calling onUse", () => {
    const onUse = vi.fn();
    render(<BlueprintLibrary activeBlueprintId={FIRST_ID} onUse={onUse} />);
    fireEvent.click(screen.getByTestId(`blueprint-use-${SECOND_ID}`));
    fireEvent.click(screen.getByTestId("reset-modal-export"));
    expect(onUse).not.toHaveBeenCalled();
    expect(screen.queryByTestId("blueprint-reset-modal")).toBeNull();
  });

  it("shows reset modal for pre-tracking projects (activeBlueprintId = 'default')", () => {
    const onUse = vi.fn();
    render(<BlueprintLibrary activeBlueprintId="default" onUse={onUse} />);
    fireEvent.click(screen.getByTestId(`blueprint-use-${FIRST_ID}`));
    expect(onUse).not.toHaveBeenCalled();
    expect(screen.getByTestId("blueprint-reset-modal")).toBeTruthy();
  });
});

// ----------------------------------------------------------------
// BlueprintResetModal — standalone tests
// ----------------------------------------------------------------
describe("BlueprintResetModal", () => {
  it("displays the blueprint name in the header", () => {
    render(
      <BlueprintResetModal
        blueprintName="API service"
        onCancel={vi.fn()} onExport={vi.fn()} onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/API service/)).toBeTruthy();
  });

  it("contains 'resets to a fresh state' warning (#664)", () => {
    render(
      <BlueprintResetModal
        blueprintName="CLI tool"
        onCancel={vi.fn()} onExport={vi.fn()} onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/resets to a fresh state/)).toBeTruthy();
  });

  it("fires onCancel when cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(
      <BlueprintResetModal
        blueprintName="CLI"
        onCancel={onCancel} onExport={vi.fn()} onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("reset-modal-cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("fires onExport when 'export files' button is clicked", () => {
    const onExport = vi.fn();
    render(
      <BlueprintResetModal
        blueprintName="CLI"
        onCancel={vi.fn()} onExport={onExport} onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("reset-modal-export"));
    expect(onExport).toHaveBeenCalledOnce();
  });

  it("fires onConfirm when 'confirm & restart' button is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <BlueprintResetModal
        blueprintName="CLI"
        onCancel={vi.fn()} onExport={vi.fn()} onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId("reset-modal-confirm"));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
