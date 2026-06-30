import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { DependenciesPage } from "./DependenciesPage";
import { useAppStore } from "@/store";

const NOT_READY = {
  platform: "linux",
  needsWsl: false,
  wslInstalled: false,
  sandboxDistro: null,
  autoInstallable: true,
  ready: false,
  detail: "bubblewrap not installed — install with `sudo apt-get install -y bubblewrap socat`.",
};

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "wsl_sandbox_status") return NOT_READY;
    if (cmd === "preflight") return []; // host-tool probe — empty for this smoke test
    return undefined;
  });
  useAppStore.setState({ bypassPermissions: true });
});

describe("DependenciesPage", () => {
  it("presents the dependencies inform-first (no auto-install) with an explicit sandbox install", async () => {
    render(<DependenciesPage />);
    expect(screen.getByText("Required dependencies")).toBeInTheDocument();
    // The inform-first promise is stated explicitly.
    expect(screen.getByText(/installed automatically/i)).toBeInTheDocument();
    // The sandbox row offers the explicit install action (only after surfacing the gap).
    expect(await screen.findByRole("button", { name: /Install bubblewrap/ })).toBeInTheDocument();
  });

  it("omits the sandbox row in the allow-list posture (it isn't required then)", () => {
    useAppStore.setState({ bypassPermissions: false });
    render(<DependenciesPage />);
    expect(screen.getByText("Required dependencies")).toBeInTheDocument();
    expect(screen.queryByText("OS sandbox (Bash isolation)")).toBeNull();
  });
});
