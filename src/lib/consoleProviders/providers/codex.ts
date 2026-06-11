import type { ConsoleProvider } from "../types";

export const codexProvider: ConsoleProvider = {
  id: "codex",
  displayName: "OpenAI Codex CLI",
  buildLaunchCmd: () => "codex",
  prereqProbe: "which codex",
};
