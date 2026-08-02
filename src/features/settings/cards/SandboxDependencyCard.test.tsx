import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { SandboxDependencyCard } from "./SandboxDependencyCard";
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
  vi.mocked(invoke).mockImplementation(async (cmd: string) =>
    cmd === "wsl_sandbox_status" ? NOT_READY : undefined,
  );
  useAppStore.setState({ bypassPermissions: true });
});

describe("SandboxDependencyCard", () => {
  it("surfaces the gap inform-first with an explicit (not automatic) install action", async () => {
    render(<SandboxDependencyCard />);
    expect(await screen.findByText(/Not set up/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Install bubblewrap/ })).toBeInTheDocument();
  });

  it("renders nothing in the allow-list posture (the sandbox isn't required then)", () => {
    useAppStore.setState({ bypassPermissions: false });
    const { container } = render(<SandboxDependencyCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("surfaces a sealed distro that can't host the fleet, even when the sandbox reads as Active (#4260)", async () => {
    // The two axes are independent: bubblewrap can be fine while the imported distro predates the
    // baked-in runtimes and has no `claude` to run. If this only rendered under `ready: false`, the
    // gap would stay invisible until an agent hit it mid-task.
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "wsl_sandbox_status"
        ? {
            ...NOT_READY,
            ready: true,
            detail: "Ready — the Bash sandbox can run in `bsc-agent-sandbox`.",
            agentSandboxRuntimes: { claude: false, bscAgent: true, gh: false, git: true },
            agentSandboxGap: "The imported `bsc-agent-sandbox` distro is missing Claude Code (the default harness) — rebuild the rootfs from tooling/wsl-sandbox/ and re-import it.",
          }
        : undefined,
    );
    render(<SandboxDependencyCard />);
    expect(await screen.findByText(/Active/)).toBeInTheDocument();
    expect(screen.getByText(/missing Claude Code/)).toBeInTheDocument();
    expect(screen.getByText(/rebuild the rootfs/i)).toBeInTheDocument();
  });

  it("says nothing extra when the distro can host the whole fleet", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "wsl_sandbox_status"
        ? { ...NOT_READY, agentSandboxRuntimes: { claude: true, bscAgent: true, gh: true, git: true }, agentSandboxGap: null }
        : undefined,
    );
    render(<SandboxDependencyCard />);
    expect(await screen.findByText(/Not set up/)).toBeInTheDocument();
    expect(screen.queryByText(/rebuild the rootfs/i)).not.toBeInTheDocument();
  });
});
