import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { StorageCard } from "./StorageCard";

// The Tauri `invoke` mock is pre-wired in src/test/setup.ts; we just script per-command returns.
const mockInvoke = vi.mocked(invoke);

const USAGE = [
  { projectKey: "proj-a", name: "web--auth", path: "/wt/proj-a/web--auth", sizeBytes: 5_000_000_000, targetBytes: 4_500_000_000 },
  { projectKey: "proj-a", name: "api--svc", path: "/wt/proj-a/api--svc", sizeBytes: 1_000_000, targetBytes: 0 },
  { projectKey: "proj-b", name: "app--ui", path: "/wt/proj-b/app--ui", sizeBytes: 2_000_000, targetBytes: 1_500_000 },
];

const SANDBOX = { installed: true, distroBytes: 300_000_000, tarballBytes: 205_000_000 };

beforeEach(() => {
  localStorage.clear(); // the card caches its last scan in localStorage — isolate each test
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "worktrees_disk_usage") return Promise.resolve(USAGE);
    if (cmd === "reclaim_worktrees") return Promise.resolve(2);
    if (cmd === "sandbox_disk_usage") return Promise.resolve(SANDBOX);
    if (cmd === "remove_sandbox") return Promise.resolve(505_000_000);
    return Promise.resolve(undefined);
  });
});

describe("StorageCard", () => {
  it("lists worktrees grouped by project with sizes", async () => {
    render(<StorageCard />);
    await waitFor(() => expect(screen.getByText("proj-a")).toBeInTheDocument());
    expect(screen.getByText("proj-b")).toBeInTheDocument();
    expect(screen.getByText("web--auth")).toBeInTheDocument();
    // Grand total of 3 worktrees surfaces in the header.
    expect(screen.getByText(/3 worktrees/)).toBeInTheDocument();
    // GB formatting surfaces for the multi-GB worktree.
    expect(screen.getAllByText(/GB/).length).toBeGreaterThan(0);
  });

  it("reclaims a project's worktrees on confirm and refreshes", async () => {
    render(<StorageCard />);
    await waitFor(() => expect(screen.getByText("proj-a")).toBeInTheDocument());

    // proj-a is the biggest (sorted first) → its Reclaim is the first one.
    const reclaimBtns = screen.getAllByText("Reclaim");
    fireEvent.click(reclaimBtns[0]); // arm
    fireEvent.click(screen.getByText("Confirm")); // confirm

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("reclaim_worktrees", { projectKey: "proj-a" }),
    );
    // It refreshes after reclaiming (a second usage fetch).
    await waitFor(() =>
      expect(mockInvoke.mock.calls.filter((c) => c[0] === "worktrees_disk_usage").length).toBeGreaterThanOrEqual(2),
    );
  });

  it("shows an empty state when there are no worktrees", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "worktrees_disk_usage" ? Promise.resolve([]) : Promise.resolve(undefined),
    );
    render(<StorageCard />);
    await waitFor(() => expect(screen.getByText(/No fleet worktrees on disk/)).toBeInTheDocument());
  });

  it("surfaces the WSL2 agent sandbox footprint and removes it on confirm (#1988)", async () => {
    render(<StorageCard />);
    await waitFor(() => expect(screen.getByText("Agent sandbox (WSL2)")).toBeInTheDocument());
    expect(screen.getByText(/distro image/)).toBeInTheDocument();
    expect(screen.getByText(/cached image/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Remove")); // arm
    fireEvent.click(screen.getByText("Confirm")); // confirm
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("remove_sandbox"));
  });

  it("hides the sandbox section when no sandbox is installed", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "worktrees_disk_usage") return Promise.resolve([]);
      if (cmd === "sandbox_disk_usage") return Promise.resolve({ installed: false, distroBytes: 0, tarballBytes: 0 });
      return Promise.resolve(undefined);
    });
    render(<StorageCard />);
    await waitFor(() => expect(screen.getByText(/No fleet worktrees on disk/)).toBeInTheDocument());
    expect(screen.queryByText("Agent sandbox (WSL2)")).not.toBeInTheDocument();
  });

  it("renders a fresh cache instantly and skips the mount scan", () => {
    localStorage.setItem("bsc:storageDisk", JSON.stringify({ rows: USAGE, sandbox: SANDBOX, takenAt: Date.now() }));
    render(<StorageCard />);
    // Cached rows show without waiting on any scan…
    expect(screen.getByText("proj-a")).toBeInTheDocument();
    // …and the heavy disk scan is NOT fired while the cache is fresh.
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "worktrees_disk_usage").length).toBe(0);
  });

  it("re-scans on mount when the cache is stale", async () => {
    localStorage.setItem("bsc:storageDisk", JSON.stringify({ rows: [], sandbox: null, takenAt: Date.now() - 10 * 60_000 }));
    render(<StorageCard />);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("worktrees_disk_usage"));
  });
});
