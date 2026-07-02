import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProfileBar } from "./ProfileBar";
import type { ConfigProfile } from "@/store";

const profiles: ConfigProfile[] = [
  { id: "p1", name: "read-only", instructions: "", tools: { allow: [], deny: [] } },
];

function baseProps() {
  return {
    configProfiles: profiles,
    activeProfileId: null as string | null,
    setActiveProfileId: vi.fn(),
    loadProfile: vi.fn(),
    showSaveDialog: false,
    setShowSaveDialog: vi.fn(),
    newProfileName: "",
    setNewProfileName: vi.fn(),
    handleSaveProfile: vi.fn(),
    removeConfigProfile: vi.fn(),
    targetLabel: "global",
  };
}

describe("ProfileBar", () => {
  it("renders the profile select with each profile name and the target label", () => {
    render(<ProfileBar {...baseProps()} />);
    expect(screen.getByText("read-only")).toBeInTheDocument();
    expect(screen.getByText("— custom / unsaved —")).toBeInTheDocument();
    expect(screen.getByText("global")).toBeInTheDocument();
  });

  it("opens the save dialog when 'save as profile…' is clicked", () => {
    const props = baseProps();
    render(<ProfileBar {...props} />);
    fireEvent.click(screen.getByText("save as profile…"));
    expect(props.setShowSaveDialog).toHaveBeenCalledWith(true);
  });

  it("shows the save-dialog input + save/cancel while showSaveDialog is true", () => {
    render(<ProfileBar {...baseProps()} showSaveDialog={true} />);
    expect(screen.getByPlaceholderText("profile name…")).toBeInTheDocument();
    expect(screen.getByText("save")).toBeInTheDocument();
    expect(screen.getByText("cancel")).toBeInTheDocument();
  });
});
