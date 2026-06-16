import type { ConsoleProvider } from "../types";

const DEFAULT_MODEL = "llama3";

export const ollamaProvider: ConsoleProvider = {
  id: "ollama",
  displayName: "Ollama",
  buildLaunchCmd: (config) => `ollama run ${config?.model ?? DEFAULT_MODEL}`,
  prereqProbe: "which ollama",
};
