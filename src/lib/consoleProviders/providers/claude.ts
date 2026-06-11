import type { ConsoleProvider } from "../types";

export const claudeProvider: ConsoleProvider = {
  id: "claude",
  displayName: "Claude Code",
  buildLaunchCmd: () => "claude",
  prereqProbe: "which claude",
  isClaude: true,
};
