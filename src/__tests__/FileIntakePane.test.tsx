import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { FileIntakePane } from "../screens/projects/FileIntakePane";

describe("FileIntakePane (#604)", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("renders the drop zone", () => {
    vi.mocked(invoke).mockResolvedValue([]);
    render(<FileIntakePane projectKey="p" />);
    expect(screen.getByText(/Drop design or any files/i)).toBeInTheDocument();
  });

  it("lists files already staged in the intake manifest", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      ["intake.json", JSON.stringify([{ name: "hero.png", kind: "image", size: 2048 }])],
    ]);
    render(<FileIntakePane projectKey="p" />);
    expect(await screen.findByText("hero.png")).toBeInTheDocument();
    expect(screen.getByText("image")).toBeInTheDocument(); // kind chip
  });
});
