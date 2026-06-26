// useGithubConnect (#1708) — the GitHub connection state machine, extracted out of the
// `ConnectCard` UI in settings/GitHub.tsx. It owns the two ways to connect — a Personal
// Access Token (the always-available fallback) and the OAuth Device Flow (#594) — plus the
// post-auth exchange (`finishConnect`) that turns a validated token into the user + repo
// list and flips the store to connected. The component that consumes this is pure render.
//
// The pure device-flow interpreter + driver lives in @/features/github/lib/githubDeviceFlow
// (`runDeviceFlow` / `mapDevicePoll`); this hook is the React-side wiring around it: the UI
// state, the generation-token cancellation, and the Tauri/store side effects.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore, type GithubUser, type GithubRepo } from "@/store";
import { clearGithubCache } from "@/shared/lib/github/github";
import {
  runDeviceFlow,
  type DeviceStartInfo,
  type DevicePollResult,
} from "@/features/github/lib/githubDeviceFlow";

/** Mirror of the backend `DeviceStart` struct (`github_device_start`). */
export type DeviceStart = DeviceStartInfo;

// `project` is required to read AND create GitHub Projects v2 (the Projects page
// + planning publish); without it the API returns "token lacks read:project".
// `gist` lets the app publish blueprints/extensions as gists (#598 M2).
const DEVICE_SCOPE = "repo read:org read:user project gist";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Everything the ConnectCard UI needs to render + drive a connection. */
export interface GithubConnect {
  /** PAT input value + setter (controlled input). */
  token: string;
  setToken: (t: string) => void;
  /** A PAT connect (`handleConnect`) is in flight. */
  loading: boolean;
  /** The latest user-facing error from either path, or null. */
  error: string | null;
  /**
   * OAuth client id: `null` until probed; `""` means this build has no OAuth app
   * configured (offer the PAT path only); a non-empty id enables the device flow.
   */
  clientId: string | null;
  /** The active device-flow challenge (code + verification URL), or null. */
  device: DeviceStart | null;
  /** A device flow is starting/running. */
  deviceBusy: boolean;
  /** Validate + connect with the typed PAT. */
  handleConnect: () => Promise<void>;
  /** Start (or restart) the OAuth device flow. */
  handleDeviceConnect: () => Promise<void>;
  /** Abort the in-flight device flow and clear the challenge. */
  cancelDevice: () => void;
}

/**
 * The connection state machine behind the GitHub Settings ConnectCard.
 *
 * Cancellation uses a generation token (`runIdRef`), bumped each time a flow starts or is
 * cancelled, so a stale run never updates the UI and starting over supersedes the previous
 * loop — WITHOUT tying cancellation to unmount. Navigating away does NOT abort an in-flight
 * authorization (#594); the flow runs to completion and `finishConnect`'s store write lands
 * regardless of which screen is shown. (No mounted-ref guard: React 18 ignores setState after
 * unmount, and a mounted-ref stuck false under StrictMode's dev double-mount was itself a bug.)
 */
export function useGithubConnect(): GithubConnect {
  const { setGithubToken, setGithubUser, setGithubRepos, setActiveRepo, setGithubConnected } = useAppStore();

  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [clientId, setClientId] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceStart | null>(null);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const runIdRef = useRef(0);

  useEffect(() => {
    invoke<string>("github_client_id").then(setClientId).catch(() => setClientId(""));
  }, []);

  // Exchange a validated token for the user + repo list and flip to connected.
  async function finishConnect(t: string) {
    // New token (possibly a different account) — drop any cached bodies first.
    await clearGithubCache().catch(() => {});
    const user = await invoke<GithubUser>("github_request", { token: t, path: "user" });
    const repos = await invoke<GithubRepo[]>("github_request", {
      token: t,
      path: "user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
    });
    setGithubToken(t);
    setGithubUser(user);
    setGithubRepos(Array.isArray(repos) ? repos : []);
    if (Array.isArray(repos) && repos.length > 0) {
      setActiveRepo(repos[0].full_name);
    }
    setGithubConnected(true);
  }

  async function handleConnect() {
    const t = token.trim();
    if (!t) return;
    setLoading(true);
    setError(null);
    try {
      await finishConnect(t);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleDeviceConnect() {
    const myRun = ++runIdRef.current;
    // Apply UI updates only for the current run (a restart bumps runIdRef and supersedes
    // a still-running older loop). finishConnect (the store write) is intentionally NOT
    // guarded — it must land even after navigating away.
    const ui = (fn: () => void) => { if (runIdRef.current === myRun) fn(); };
    ui(() => { setError(null); setDeviceBusy(true); });
    try {
      await runDeviceFlow({
        start: () => invoke<DeviceStart>("github_device_start", { scope: DEVICE_SCOPE }),
        poll: (deviceCode) => invoke<DevicePollResult>("github_device_poll", { deviceCode }),
        sleep,
        // Cancelled only when the user starts a new flow — never on unmount (#594).
        isCancelled: () => runIdRef.current !== myRun,
        onDevice: (start) => {
          ui(() => setDevice(start));
          openUrl(start.verification_uri).catch(() => { /* user can use the shown URL/code manually */ });
        },
        // The store write must complete even if the user navigated away — no ui() guard.
        onSuccess: (tok) => finishConnect(tok),
        onError: (message) => ui(() => { setError(message); setDevice(null); }),
      });
    } catch (e) {
      ui(() => { setError(String(e)); setDevice(null); });
    } finally {
      ui(() => setDeviceBusy(false));
    }
  }

  function cancelDevice() {
    // Bump the generation token so the in-flight flow's isCancelled() trips.
    runIdRef.current++;
    setDevice(null);
    setDeviceBusy(false);
  }

  return {
    token, setToken,
    loading, error,
    clientId, device, deviceBusy,
    handleConnect, handleDeviceConnect, cancelDevice,
  };
}
