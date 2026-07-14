// The Sounds store bridge (#3080) — reads/writes the durable `bsc-sound` store through the generic
// `bsc` command (#2114), so the desktop Sounds library and a live session's shell share one store. A
// GLOBAL store (no per-project key), exactly like the persona bridge.
import { bscJson, bscRun, bscWrite } from "@/shared/lib/core/bsc";
import type { SoundKit } from "./soundDescriptor";

/** Every kit from the durable store (full objects), or `[]` if the store/CLI is unavailable. */
export async function loadKits(): Promise<SoundKit[]> {
  const rows = await bscJson<SoundKit[]>(null, ["sound", "list", "--full"], []);
  return Array.isArray(rows) ? rows : [];
}

/** Upsert a kit into the durable store (verbatim JSON on stdin, keyed by its `id`). */
export async function pushKit(kit: SoundKit): Promise<void> {
  await bscWrite(null, ["sound", "set"], kit);
}

/** Delete a kit from the durable store (no-op if absent). */
export async function dropKit(id: string): Promise<void> {
  await bscRun(null, ["sound", "remove", id]);
}
