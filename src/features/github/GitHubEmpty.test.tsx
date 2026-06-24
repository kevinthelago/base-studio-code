import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GitHubEmpty } from "./Empty";
import { useAppStore } from "@/store";

describe("GitHubEmpty — Connect with GitHub", () => {
  it("renders the showcase and navigates to Settings → GitHub on connect", () => {
    // Start on a non-GitHub settings tab so we prove the click switches it back.
    useAppStore.getState().setSettingsSection("general");

    render(<GitHubEmpty />);

    // The richer GitHub-page screen carries the "what you get" feature showcase.
    expect(screen.getByText(/what you get/i)).toBeInTheDocument();
    expect(screen.getByText(/Portfolio summary/i)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Connect with GitHub/i));

    expect(useAppStore.getState().activeScreen).toBe("settings");
    expect(useAppStore.getState().settingsSection).toBe("github");
  });
});
