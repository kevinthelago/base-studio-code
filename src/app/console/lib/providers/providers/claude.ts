import type { ConsoleProvider } from "../types";
import { claudeFirstRunInstall } from "./claudeInstall";

export const claudeProvider: ConsoleProvider = {
  id: "claude",
  displayName: "Claude Code",
  buildLaunchCmd: () => "claude",
  prereqProbe: "which claude",
  isClaude: true,
  // #1277: Claude Code is Anthropic's proprietary CLI — we install it from npm on first run (with
  // consent) instead of repackaging it. See `claudeInstall.ts` for the detect → offer/guide policy.
  firstRunInstall: claudeFirstRunInstall,
};
