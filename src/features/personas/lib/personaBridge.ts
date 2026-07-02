// The frontend ↔ persona store bridge (#2094). The desktop Personas library and every live console
// session + the planner share ONE global store (`~/.base-studio-code/personas/<id>.json`), reached
// here — and from a session's own shell — through the SAME `bsc persona …` CLI, over the generic `bsc`
// bridge (#2114). Personas are GLOBAL (no project key) so every call passes `null` as the projectKey.
// This is the only place the personas feature touches Tauri, so the pure model in `persona.ts` stays
// React/Tauri-free.
//
// Source-of-truth: the persona store. The Zustand slice is a write-through cache — `loadPersonas`
// hydrates it on boot (then `reconcilePersonas` re-seeds the packaged built-ins), and each library
// mutation pushes through here. Written verbatim: the store never imposes a schema, so a persona
// round-trips byte-for-byte.
import { bsc, bscRun, bscWrite } from "@/shared/lib/core/bsc";
import type { Persona } from "./persona";

/**
 * Load every persona from the store via `bsc persona list --full`. Returns `null` when the bridge is
 * unreachable (no Tauri host — tests, the web shell, or an old binary) so the caller keeps its seeded
 * in-memory built-ins rather than blanking the library. NOT `bscJson` (its degrade-to-fallback would
 * return an empty array, which would then blank the seeded set).
 */
export async function loadPersonas(): Promise<Persona[] | null> {
  try {
    const out = await bsc(null, ["persona", "list", "--full"]);
    const rows = JSON.parse(out.trim() || "[]") as Partial<Persona>[];
    // Defensive: keep only well-formed rows (id + name + role), defaulting the rest so an odd file
    // never crashes hydration.
    return (rows ?? [])
      .filter((p): p is Persona => typeof p.id === "string" && !!p.id)
      .map((p) => ({
        id: p.id, name: p.name ?? "Untitled", blurb: p.blurb ?? "",
        role: p.role ?? "reviewer", startPrompt: p.startPrompt ?? "", skills: p.skills ?? [],
        model: p.model, builtin: p.builtin,
      }));
  } catch {
    return null;
  }
}

/** Write-through a persona upsert (`bsc persona set` reads the JSON on stdin). Fire-and-forget; never
 *  throws, so an old bundled `bsc` without the `persona` subcommand degrades to store-only silently. */
export async function pushPersona(persona: Persona): Promise<void> {
  try { await bscWrite(null, ["persona", "set"], persona); } catch { /* store unreachable — cache-only */ }
}

/** Write-through a persona removal (`bsc persona remove <id>`). Never throws (see {@link pushPersona}). */
export async function dropPersona(id: string): Promise<void> {
  try { await bscRun(null, ["persona", "remove", id]); } catch { /* store unreachable — cache-only */ }
}
