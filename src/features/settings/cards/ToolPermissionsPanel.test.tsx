import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolPermissionsPanel } from "./ToolPermissionsPanel";
import { TOOL_PRESETS } from "../lib/toolPresets";

function baseProps() {
  return {
    allow: [] as string[],
    setAllow: vi.fn(),
    deny: [] as string[],
    setDeny: vi.fn(),
    allowInput: "",
    setAllowInput: vi.fn(),
    denyInput: "",
    setDenyInput: vi.fn(),
    applyPreset: vi.fn(),
    addToAllow: vi.fn(),
    addToDeny: vi.fn(),
  };
}

describe("ToolPermissionsPanel", () => {
  it("renders every preset and the empty allow/deny placeholders", () => {
    render(<ToolPermissionsPanel {...baseProps()} />);
    for (const p of TOOL_PRESETS) {
      expect(screen.getByText(p.label)).toBeInTheDocument();
    }
    expect(screen.getByText("all tools allowed")).toBeInTheDocument();
    expect(screen.getByText("nothing denied")).toBeInTheDocument();
  });

  it("calls applyPreset when a preset chip is clicked", () => {
    const props = baseProps();
    render(<ToolPermissionsPanel {...props} />);
    fireEvent.click(screen.getByText("read-only"));
    expect(props.applyPreset).toHaveBeenCalledWith(TOOL_PRESETS.find((p) => p.label === "read-only"));
  });

  it("renders the settings.json preview when there are tool rules", () => {
    render(<ToolPermissionsPanel {...baseProps()} allow={["Read"]} />);
    expect(screen.getByText(/"permissions"/)).toBeInTheDocument();
  });
});
