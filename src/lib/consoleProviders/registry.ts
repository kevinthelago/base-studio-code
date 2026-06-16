import type { ConsoleProvider } from "./types";

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
