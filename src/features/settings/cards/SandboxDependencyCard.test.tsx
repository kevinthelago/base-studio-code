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
});
