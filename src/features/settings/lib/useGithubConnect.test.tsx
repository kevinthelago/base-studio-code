import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useGithubConnect } from "./useGithubConnect";
import { useAppStore } from "@/store";

// Focused coverage for the connection state machine extracted out of GitHub.tsx (#1708):
// the PAT path, the clientId probe, and the device-flow start that surfaces the user code.
// The pure device-flow driver (runDeviceFlow) is unit-tested separately in
// github/lib/githubDeviceFlow.test.ts; this guards the React-side wiring.
describe("useGithubConnect (#1708)", () => {
  beforeEach(() => {
    useAppStore.getState().disconnectGithub();
    vi.mocked(invoke).mockReset();
  });

  it("probes the OAuth client id on mount", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "github_client_id") return "Ov23test";
      return null;
    });
    const { result } = renderHook(() => useGithubConnect());
    await waitFor(() => expect(result.current.clientId).toBe("Ov23test"));
  });

  it("clientId falls back to \"\" when the probe rejects (no OAuth app configured)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "github_client_id") throw new Error("no client id");
      return null;
    });
    const { result } = renderHook(() => useGithubConnect());
    await waitFor(() => expect(result.current.clientId).toBe(""));
  });

  it("handleConnect exchanges a PAT for the user + repos and flips to connected", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "github_client_id") return "";
      if (cmd === "github_request" && (args as { path?: string } | undefined)?.path === "user") {
        return { login: "octocat", name: "Octo Cat" };
      }
      if (cmd === "github_request") {
        return [{ full_name: "octocat/hello", default_branch: "main" }];
      }
      return null;
    });
    const { result } = renderHook(() => useGithubConnect());

    act(() => result.current.setToken("ghp_token"));
    await act(async () => { await result.current.handleConnect(); });

    expect(useAppStore.getState().githubConnected).toBe(true);
    expect(useAppStore.getState().githubToken).toBe("ghp_token");
    expect(useAppStore.getState().githubUser?.login).toBe("octocat");
    expect(useAppStore.getState().activeRepoName).toBe("octocat/hello");
    expect(result.current.error).toBeNull();
  });

  it("handleConnect surfaces an error and stays disconnected when the exchange fails", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "github_client_id") return "";
      if (cmd === "github_request") throw new Error("bad credentials");
      return null;
    });
    const { result } = renderHook(() => useGithubConnect());

    act(() => result.current.setToken("ghp_bad"));
    await act(async () => { await result.current.handleConnect(); });

    expect(useAppStore.getState().githubConnected).toBe(false);
    expect(result.current.error).toMatch(/bad credentials/i);
    expect(result.current.loading).toBe(false);
  });

  it("handleDeviceConnect starts the flow and surfaces the device challenge", async () => {
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
    const { result } = renderHook(() => useGithubConnect());

    act(() => { void result.current.handleDeviceConnect(); });
    await waitFor(() => expect(result.current.device?.user_code).toBe("WXYZ-1234"));

    act(() => result.current.cancelDevice());
    expect(result.current.device).toBeNull();
    expect(result.current.deviceBusy).toBe(false);
  });
});
