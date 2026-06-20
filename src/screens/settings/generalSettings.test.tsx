import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GeneralSettings } from "./General";
import { useAppStore } from "../../store";

describe("GeneralSettings", () => {
  beforeEach(() => {
    // Known seed so each control has a deterministic starting state.
    useAppStore.setState({
      bscBaseDir: "/home/me/.base-studio-code",
      defaultModel: "sonnet-4.5",
      autoResumeClaude: true,
      autoAdvanceOnReply: false,
    });
  });

  it("renders the general settings cards (no 'coming soon')", () => {
    render(<GeneralSettings />);
    expect(screen.getByText("General")).toBeTruthy();
    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(screen.getByText("Default model")).toBeTruthy();
    expect(screen.getByText("Sessions & console behavior")).toBeTruthy();
    expect(screen.getByText("Auto-resume Claude on restart")).toBeTruthy();
  });

  it("shows the base directory from the store and writes edits back", () => {
    render(<GeneralSettings />);
    const input = screen.getByPlaceholderText("~/.base-studio-code") as HTMLInputElement;
    expect(input.value).toBe("/home/me/.base-studio-code");
    fireEvent.change(input, { target: { value: "/tmp/work" } });
    expect(useAppStore.getState().bscBaseDir).toBe("/tmp/work");
  });

  it("reflects the default model and persists a change", () => {
    const { container } = render(<GeneralSettings />);
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("sonnet-4.5");
    fireEvent.change(select, { target: { value: "opus-4.5" } });
    expect(useAppStore.getState().defaultModel).toBe("opus-4.5");
  });

  it("toggles auto-resume and cycle-on-reply and writes to the store", () => {
    render(<GeneralSettings />);
    const switches = screen.getAllByRole("switch");
    // Order in the card: auto-resume (on), cycle-on-reply (off).
    expect(switches[0].getAttribute("aria-checked")).toBe("true");
    expect(switches[1].getAttribute("aria-checked")).toBe("false");

    fireEvent.click(switches[0]);
    expect(useAppStore.getState().autoResumeClaude).toBe(false);

    fireEvent.click(switches[1]);
    expect(useAppStore.getState().autoAdvanceOnReply).toBe(true);
  });
});
