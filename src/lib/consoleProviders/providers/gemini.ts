import type { ConsoleProvider } from "../types";

export const geminiProvider: ConsoleProvider = {
  id: "gemini",
  displayName: "Gemini CLI",
  buildLaunchCmd: () => "gemini",
  prereqProbe: "which gemini",
};
