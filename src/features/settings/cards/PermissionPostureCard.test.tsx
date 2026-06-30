import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { PermissionPostureCard } from "./PermissionPostureCard";
import { useAppStore } from "@/store";

// The Tauri `invoke` mock is pre-wired in src/test/setup.ts; we just script the probe's return.
const mockInvoke = vi.mocked(invoke);

const NOT_READY = {
  platform: "windows",
  needsWsl: true,
  wslInstalled: true,
  sandboxDistro: "docker-desktop",
  ready: false,
  detail: "`docker-desktop` is missing bubblewrap — run `sudo apt-get install -y bubblewrap socat` inside it.",
};

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((cmd: string) =>
    cmd === "wsl_sandbox_status" ? Promise.resolve(NOT_READY) : Promise.resolve(undefined),
  );
  useAppStore.setState({ bypassPermissions: true });
});

describe("PermissionPostureCard", () => {
  it("surfaces the OS-sandbox readiness under bypass (deny-list)", async () => {
    render(<PermissionPostureCard />);
    expect(screen.getByText("Autonomous agents (deny-list)")).toBeInTheDocument();
    // The #1982 probe verdict + its remediation surface inline.
    await waitFor(() => expect(screen.getByText(/needs WSL2/)).toBeInTheDocument());
    expect(screen.getByText(/missing bubblewrap/)).toBeInTheDocument();
  });

  it("hides the sandbox line in allow-list posture", async () => {
    useAppStore.setState({ bypassPermissions: false });
    render(<PermissionPostureCard />);
    // The probe still runs, but the readiness line is gated on bypass (prompts are the gate here).
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("wsl_sandbox_status", undefined));
    expect(screen.queryByText(/OS sandbox/)).not.toBeInTheDocument();
  });
});
