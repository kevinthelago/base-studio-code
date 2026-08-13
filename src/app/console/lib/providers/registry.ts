import type { ConsoleProvider } from "./types";
import { claudeProvider } from "./providers/claude";
import { geminiProvider } from "./providers/gemini";
import { codexProvider } from "./providers/codex";
import { aiderProvider } from "./providers/aider";
import { ollamaProvider } from "./providers/ollama";
import { amazonQProvider } from "./providers/amazonq";
import { bscAgentProvider } from "./providers/bscAgent";

const REGISTRY = new Map<string, ConsoleProvider>();

export function registerProvider(p: ConsoleProvider): void {
  REGISTRY.set(p.id, p);
}

export function getProvider(id: string): ConsoleProvider | undefined {
  return REGISTRY.get(id);
}

export function listProviders(): ConsoleProvider[] {
  return [...REGISTRY.values()];
}

// The built-in provider set, seeded HERE — in the module that owns the map — rather than in the
// barrel (providers-register-in-the-registry-that-owns-them).
//
// Two things this buys. Anyone reaching `getProvider` necessarily loads THIS module, so the built-ins
// are guaranteed present; when the barrel seeded them, a consumer importing `./registry` directly got
// an empty map, and the guarantee rested on which path you happened to take. And the barrel becomes
// re-exports only, which is what lets it be a record rather than a file that must RUN to be correct.
//
// This module cannot be a record either way: it holds REGISTRY, a live map. Seeding it here therefore
// costs nothing that was not already spent.
registerProvider(claudeProvider);
registerProvider(geminiProvider);
registerProvider(codexProvider);
registerProvider(aiderProvider);
registerProvider(ollamaProvider);
registerProvider(amazonQProvider);
registerProvider(bscAgentProvider);
