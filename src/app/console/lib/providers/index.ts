export type { ConsoleProvider, ProviderLaunchConfig } from "./types";
export { registerProvider, getProvider, listProviders } from "./registry";

import { registerProvider } from "./registry";
import { claudeProvider } from "./providers/claude";
import { geminiProvider } from "./providers/gemini";
import { codexProvider } from "./providers/codex";
import { aiderProvider } from "./providers/aider";
import { ollamaProvider } from "./providers/ollama";
import { amazonQProvider } from "./providers/amazonq";
import { bscAgentProvider } from "./providers/bscAgent";

registerProvider(claudeProvider);
registerProvider(geminiProvider);
registerProvider(codexProvider);
registerProvider(aiderProvider);
registerProvider(ollamaProvider);
registerProvider(amazonQProvider);
registerProvider(bscAgentProvider);
