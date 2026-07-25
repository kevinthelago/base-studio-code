// Sound-kit RESOLUTION for the Design Studio (#3412, epic #3071) — the step that turns a blueprint's
// `soundKit` PIN (config, #3372) into the kit a `@bsc/sounds/<id>` import actually resolves against.
//
// #3372 shipped the pin and its store resolution; until now `libraryModules.ts` still resolved every sound
// reference against the first packaged built-in, so a component referencing `@bsc/sounds/click` played the
// STARTER kit's click even when its project pinned a different kit. The picker said the pin took effect and
// it silently did not — a correctness gap whose failure mode is INAUDIBLE, which is why the policy below
// never degrades quietly.
//
// The read side of the pin: the artifact already lives in the global versioned release store (written by
// `resolveSoundKitPin` on blueprint open/import, #3372), so this only READS it —
// `bsc sound release get <id@version> --artifact` — and never fetches, verifies, or writes. A pin whose
// artifact is missing is therefore a genuine, reportable breakage (the resolve step failed or the store was
// tampered with), not a cache miss to paper over.
//
// Pure of React; store access goes through the generic `bsc` bridge (#2114), the same surface a live
// session reaches with `bsc sound release …` from its own shell.
import { bsc } from "@/shared/lib/core/bsc";
import { validateKit, type SoundKit } from "@/features/sounds";
import type { BlueprintSoundKit } from "@/features/planner/stages/blueprints";
import { DEFAULT_SOUND_KIT, type SoundKitSelection } from "./libraryModules";

/** `id@version` — the store ref a pin resolves as. Mirrors `soundKitRef` (planner `soundKitPin.ts`); kept
 *  local so the designs feature reads a pin without reaching into the planner's internals. */
export function pinRef(pin: Pick<BlueprintSoundKit, "id" | "version">): string {
  return `${pin.id}@${pin.version}`;
}

/**
 * Resolve a blueprint's sound-kit pin into the {@link SoundKitSelection} the Design Studio's library
 * resolvers run under (#3412). ONE DEFAULT, TWO LOUD FAILURES:
 *
 *  · no pin ⇒ `{ kind: "default" }` — the packaged starter kit, exactly as before #3412. An unpinned
 *    project's resolution is unchanged.
 *  · pin present + its artifact reads + parses as a valid kit ⇒ `{ kind: "pinned" }`.
 *  · pin present but UNRESOLVABLE — missing artifact, malformed JSON, a structurally invalid kit, or a
 *    bridge failure ⇒ `{ kind: "unresolved" }`, which drops the sound arm entirely so every
 *    `@bsc/sounds/…` surfaces as an unresolvable import. NEVER a silent degrade to the starter kit: the
 *    user cannot hear that the wrong kit loaded.
 *
 * Never throws — a bridge rejection becomes the `unresolved` arm, so a caller wires one code path.
 */
export async function selectSoundKit(pin: BlueprintSoundKit | undefined): Promise<SoundKitSelection> {
  if (!pin) return DEFAULT_SOUND_KIT;
  const ref = pinRef(pin);
  let raw: string;
  try {
    raw = (await bsc(null, ["sound", "release", "get", ref, "--artifact"])).trim();
  } catch (e) {
    return { kind: "unresolved", ref, error: `sound kit ${ref} could not be read from the store: ${String(e)}` };
  }
  // The CLI prints `null` (or nothing) for a ref the store doesn't hold — the pin resolved to no artifact.
  if (!raw || raw === "null") {
    return {
      kind: "unresolved",
      ref,
      error: `sound kit ${ref} is pinned but is not in the local sound-kit store — reopen the blueprint to resolve its pin`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { kind: "unresolved", ref, error: `sound kit ${ref} artifact is not valid JSON: ${String(e)}` };
  }
  const kit = asSoundKit(parsed);
  if (!kit) {
    return { kind: "unresolved", ref, error: `sound kit ${ref} artifact is not a sound kit (no id / cues)` };
  }
  // A kit whose voices/cues reference missing parts would resolve imports that then fail INSIDE the player
  // module — catch it here so the breakage is reported at the pin, where it can be fixed.
  const problems = validateKit(kit);
  if (problems.length > 0) {
    return { kind: "unresolved", ref, error: `sound kit ${ref} is structurally invalid: ${problems.join("; ")}` };
  }
  return { kind: "pinned", ref, kit };
}

/** Narrow a parsed artifact to a {@link SoundKit} — the shape the store's `validate_artifact` already
 *  enforces on write (a non-empty top-level `cues`), re-checked here because the artifact crossed a
 *  process boundary. Missing optional collections normalize to `[]` so `validateKit` can run. */
function asSoundKit(v: unknown): SoundKit | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<SoundKit>;
  if (typeof o.id !== "string" || !o.id) return null;
  if (!Array.isArray(o.cues) || o.cues.length === 0) return null;
  return {
    ...(o as SoundKit),
    primitives: Array.isArray(o.primitives) ? o.primitives : [],
    voices: Array.isArray(o.voices) ? o.voices : [],
    cues: o.cues,
  };
}
