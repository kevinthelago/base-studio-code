import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { DiagnosticsSettings } from "./Diagnostics";
import type { PrereqStatus } from "../../lib/core/diagnostics";

const mockInvoke = vi.mocked(invoke);

const prereq = (p: Partial<PrereqStatus> & { name: string }): PrereqStatus => ({
  found: true,
  version: null,
  path: null,
  hint: "",
  ...p,
});

beforeEach(() => {
  globalThis.localStorage?.clear?.();
  mockInvoke.mockReset();
});

/**
 * Route invoke by command name: `preflight` returns the given prereqs, the shell
 * commands behave sanely, and anything else resolves null. The view fires
 * `preflight` and `get_preferred_shell` concurrently on mount, so order-based
 * mocks are unreliable — key on the command instead.
 */
function routeInvoke(prereqs: PrereqStatus[] | Error) {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "preflight") {
      return prereqs instanceof Error ? Promise.reject(prereqs.message) : Promise.resolve(prereqs);
    }
    if (cmd === "get_preferred_shell") return Promise.resolve("auto");
    return Promise.resolve(null);
  });
}

describe("DiagnosticsSettings", () => {
  it("renders each probed prerequisite with its status", async () => {
    routeInvoke([
      prereq({ name: "Git Bash", path: "C:/Git/bin/bash.exe" }),
      prereq({ name: "claude", version: "claude 1.2.3", path: "/usr/bin/claude" }),
      prereq({ name: "git", version: "git version 2.43.0", path: "/usr/bin/git" }),
    ]);
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(screen.getByText("Git Bash")).toBeTruthy());
    // Version/path are unique to the rendered rows (the intro prose only names the tools).
    expect(screen.getByText("claude 1.2.3")).toBeTruthy();
    expect(screen.getByText("git version 2.43.0")).toBeTruthy();
    expect(screen.getByText("C:/Git/bin/bash.exe")).toBeTruthy();
    expect(screen.getByText(/All prerequisites satisfied/)).toBeTruthy();
    // The probe was invoked with the global (no-cwd) form.
    expect(mockInvoke).toHaveBeenCalledWith("preflight", { cwd: "", env: null });
  });

  it("surfaces a specific consequence + install link for a missing prerequisite", async () => {
    routeInvoke([
      prereq({ name: "claude", found: false, hint: "Install the Claude CLI — see https://docs.claude.com/claude-code" }),
    ]);
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(screen.getByText(/Agents can't run/)).toBeTruthy());
    const link = screen.getByText(/docs\.claude\.com/);
    expect(link.getAttribute("href")).toBe("https://docs.claude.com/claude-code");
  });

  it("shows a probe failure without crashing", async () => {
    routeInvoke(new Error("shell not found"));
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(screen.getByText(/Probe failed: shell not found/)).toBeTruthy());
  });

  it("renders the shell selector and persists a choice via the backend", async () => {
    routeInvoke([]);
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(screen.getByText("Console shell")).toBeTruthy());

    fireEvent.click(screen.getByText("PowerShell"));
    // The backend is told to persist the new selection…
    expect(mockInvoke).toHaveBeenCalledWith("set_preferred_shell", { kind: "powershell" });
    // …and the degraded-helpers warning surfaces for a non-bash shell.
    expect(screen.getByText(/bash-only/)).toBeTruthy();
  });
});
