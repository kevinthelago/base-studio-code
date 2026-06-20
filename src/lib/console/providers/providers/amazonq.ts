import type { ConsoleProvider } from "../types";

export const amazonQProvider: ConsoleProvider = {
  id: "amazonq",
  displayName: "Amazon Q Developer",
  buildLaunchCmd: () => "q",
  prereqProbe: "which q",
};
