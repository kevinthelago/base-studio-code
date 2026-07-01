import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SandboxedConsolesCard } from "./SandboxedConsolesCard";
import { useAppStore } from "@/store";

describe("SandboxedConsolesCard", () => {
  beforeEach(() => useAppStore.setState({ sandboxConsoles: false }));

  it("toggles running new consoles inside the WSL2 sandbox", () => {
    render(<SandboxedConsolesCard />);
    expect(screen.getByText(/Run new console sessions inside the WSL2 sandbox/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch"));
    expect(useAppStore.getState().sandboxConsoles).toBe(true);
  });
});
