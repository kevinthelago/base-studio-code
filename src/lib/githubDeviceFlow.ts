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
