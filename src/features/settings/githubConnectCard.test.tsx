import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { GitHubSettings } from "./GitHub";
import { useAppStore } from "@/store";

// Behavioral coverage for the device-flow card (#594): clicking Connect surfaces the
// user code. The original #594 regression (the device code never rendered) only
// manifested under React StrictMode's dev double-mount, which jsdom/vitest does not
// reproduce — which is exactly why the fix removed the fragile mounted-ref guard
// rather than patching it. This guards the happy-path rendering going forward.
describe("GitHub ConnectCard — device code", () => {
  beforeEach(() => {
    useAppStore.getState().disconnectGithub(); // ensure the ConnectCard is shown
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "github_client_id") return "Ov23test";
      if (cmd === "github_device_start") {
        return {
          device_code: "dc", user_code: "WXYZ-1234",
          verification_uri: "https://github.com/login/device",
          interval: 3600, expires_in: 3600, // huge interval → the poll never sleeps within the test
        };
      }
      if (cmd === "github_device_poll") return { error: "authorization_pending" };
      return null;
    });
  });

  it("renders the user code after clicking Connect", async () => {
    render(<GitHubSettings />);
    const connect = await screen.findByRole("button", { name: /Connect with GitHub/i });
    fireEvent.click(connect);
    expect(await screen.findByText("WXYZ-1234")).toBeInTheDocument();
  });
});
