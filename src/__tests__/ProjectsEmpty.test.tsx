import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectsEmpty } from "../screens/planner/list/Empty";
import { useAppStore } from "../store";

describe("ProjectsEmpty — Connect with GitHub", () => {
  it("navigates to the Settings screen AND selects the GitHub tab", () => {
    // Start on a non-GitHub settings tab so we prove the click switches it back
    // (the bug: it only set the screen, leaving the last-visited tab open).
    useAppStore.getState().setSettingsSection("general");

    render(<ProjectsEmpty />);
    fireEvent.click(screen.getByText(/Connect with GitHub/i));

    expect(useAppStore.getState().activeScreen).toBe("settings");
    expect(useAppStore.getState().settingsSection).toBe("github");
  });
});
