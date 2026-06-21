import type { ConsoleProvider } from "../types";

export const aiderProvider: ConsoleProvider = {
  id: "aider",
  displayName: "Aider",
  buildLaunchCmd: () => "aider",
  prereqProbe: "which aider",
};
