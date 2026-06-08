// githubDeviceFlow -- pure interpretation of a GitHub OAuth Device Flow poll.
//
// The backend `github_device_poll` command performs one token exchange and returns
// `{ access_token?, error? }`. This module turns that raw result (plus the current
// poll interval) into the next action the UI should take, so the polling component
// stays a thin loop and the branching logic is unit-testable without Tauri.
//
// GitHub's device-flow error strings (see the OAuth docs):
//   authorization_pending — user hasn't authorized yet; keep polling at the interval
//   slow_down             — polling too fast; keep going but add 5s to the interval
//   expired_token         — the device code expired; restart the flow
//   access_denied         — the user cancelled at github.com; restart the flow
//   (others)              — treated as fatal with the raw message

/** Raw shape returned by the `github_device_poll` Tauri command. */
export interface DevicePollResult {
  access_token?: string | null;
  error?: string | null;
}

/** What the polling loop should do next. */
export type DeviceFlowAction =
  | { kind: "success"; token: string }
  | { kind: "pending"; intervalSec: number }
  | { kind: "error"; message: string };

/** GitHub's `slow_down` asks the client to add at least 5s to its poll interval. */
export const SLOW_DOWN_BUMP_SEC = 5;

/**
 * Interpret one poll result into the next action.
 *
 * @param res         the `{ access_token?, error? }` from `github_device_poll`
 * @param intervalSec the current poll interval (seconds), echoed back on `pending`
 *                    and bumped on `slow_down`
 */
export function mapDevicePoll(res: DevicePollResult, intervalSec: number): DeviceFlowAction {
  if (res.access_token) {
    return { kind: "success", token: res.access_token };
  }
  switch (res.error) {
    case "authorization_pending":
      return { kind: "pending", intervalSec };
    case "slow_down":
      return { kind: "pending", intervalSec: intervalSec + SLOW_DOWN_BUMP_SEC };
    case "expired_token":
      return { kind: "error", message: "The code expired before you authorized. Please try again." };
    case "access_denied":
      return { kind: "error", message: "Authorization was cancelled on GitHub." };
    case undefined:
    case null:
    case "":
      return { kind: "error", message: "Unexpected response from GitHub. Please try again." };
    default:
      return { kind: "error", message: `GitHub: ${res.error}` };
  }
}

// ── Device-flow driver (#594) ─────────────────────────────────────────────────
// The start + poll loop, extracted out of the React component so it (a) is unit-
// testable without Tauri/timers and (b) is NOT tied to a component's lifecycle.
// The component used to cancel the loop on unmount, which silently aborted an
// in-flight authorization the moment the user navigated off Settings. Here,
// cancellation is an injected predicate the caller controls (an explicit restart),
// and `onSuccess` (the store write) runs to completion regardless of any UI.

/** The `github_device_start` payload (mirrors the Rust `DeviceStart`). */
export interface DeviceStartInfo {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

/** Injected dependencies — Tauri calls, timing, cancellation, and side effects. */
export interface DeviceFlowDeps {
  /** Begin the flow (→ `github_device_start`). */
  start: () => Promise<DeviceStartInfo>;
  /** Exchange the device code once (→ `github_device_poll`). */
  poll: (deviceCode: string) => Promise<DevicePollResult>;
  /** Wait between polls (the component passes a real setTimeout; tests an immediate). */
  sleep: (ms: number) => Promise<void>;
  /** Current epoch ms — injected so the expiry deadline is testable. Default Date.now. */
  now?: () => number;
  /** Cancelled when this returns true (e.g. the user restarted the flow). NOT unmount. */
  isCancelled: () => boolean;
  /** The device code is ready — show it / open the verification URL. */
  onDevice?: (info: DeviceStartInfo) => void;
  /** Authorized — persist the token. Awaited; must survive a component unmount. */
  onSuccess: (token: string) => void | Promise<void>;
  /** A user-facing error (expired / denied / unexpected). */
  onError?: (message: string) => void;
}

export type DeviceFlowOutcome =
  | { kind: "connected" }
  | { kind: "cancelled" }
  | { kind: "error"; message: string }
  | { kind: "expired" };

/**
 * Drive a GitHub OAuth Device Flow to completion: start, then poll at the server's
 * interval (honoring `slow_down`) until authorized, denied/expired, cancelled, or the
 * device code's own expiry. `onSuccess` is the only mandatory side effect and is
 * awaited, so the connection completes even if the UI that kicked it off is gone.
 */
export async function runDeviceFlow(deps: DeviceFlowDeps): Promise<DeviceFlowOutcome> {
  const now = deps.now ?? (() => Date.now());
  const info = await deps.start();
  if (deps.isCancelled()) return { kind: "cancelled" };
  deps.onDevice?.(info);

  const deadline = now() + info.expires_in * 1000;
  let intervalSec = info.interval;
  while (!deps.isCancelled() && now() < deadline) {
    await deps.sleep(intervalSec * 1000);
    if (deps.isCancelled()) return { kind: "cancelled" };
    const action = mapDevicePoll(await deps.poll(info.device_code), intervalSec);
    if (action.kind === "success") {
      await deps.onSuccess(action.token);
      return { kind: "connected" };
    }
    if (action.kind === "error") {
      deps.onError?.(action.message);
      return { kind: "error", message: action.message };
    }
    intervalSec = action.intervalSec;
  }
  if (deps.isCancelled()) return { kind: "cancelled" };
  const message = "The code expired before you authorized. Please try again.";
  deps.onError?.(message);
  return { kind: "expired" };
}
