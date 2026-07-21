import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionsBehaviorCard } from "./SessionsBehaviorCard";
import { SESSIONS_BEHAVIOR_SPEC } from "./sessionsBehaviorSpec";
import { validateGeneralNode } from "@/shared/ui/spec";
import { useAppStore } from "@/store";

describe("SessionsBehaviorCard — rung-4 spec-driven proof (#2570)", () => {
  beforeEach(() => {
    useAppStore.setState({ autoResumeClaude: false, autoAdvanceOnReply: false });
  });

  // The honesty check, now against the GENERAL validator (#3500): every `type` resolves to a real
  // manifest primitive and every prop it sets — including the `binds`/`actions` keys — is one that
  // primitive declares. Under the legacy kinds this could only assert the spec matched a closed set of
  // shapes the renderer hardcoded; it says something much stronger now.
  it("the spec validates against the real primitive contract", () => {
    expect(validateGeneralNode(SESSIONS_BEHAVIOR_SPEC)).toEqual([]);
  });

  it("renders the card title, both toggle labels, and their prose from the spec", () => {
    render(<SessionsBehaviorCard />);
    expect(screen.getByText("Sessions & console behavior")).toBeInTheDocument();
    expect(screen.getByText("Auto-resume Claude on restart")).toBeInTheDocument();
    expect(screen.getByText("Cycle to next console on reply")).toBeInTheDocument();
    expect(screen.getByText(/relaunch it with --continue/)).toBeInTheDocument();
  });

  it("reads each toggle's on/off from REAL store state (the bind read path)", () => {
    useAppStore.setState({ autoResumeClaude: true, autoAdvanceOnReply: false });
    render(<SessionsBehaviorCard />);
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(2);
    expect(switches[0]).toHaveAttribute("aria-checked", "true");
    expect(switches[1]).toHaveAttribute("aria-checked", "false");
  });

  it("writes a toggle click back to REAL store state (the bind write path)", () => {
    render(<SessionsBehaviorCard />);
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]);
    expect(useAppStore.getState().autoResumeClaude).toBe(true);
    fireEvent.click(switches[1]);
    expect(useAppStore.getState().autoAdvanceOnReply).toBe(true);
  });
});
