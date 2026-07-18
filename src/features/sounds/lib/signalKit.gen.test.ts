import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// The packaged `signal` sound kit's RELEASE-STORE identity (#3371) — the sounds twin of
// `reactUiKit.gen.test.ts` (#2465). The artifact itself is hand-authored data
// (`src-tauri/data/sounds/signal.json`), NOT generated — unlike the UI kit, a sound kit has no
// upstream manifest to derive from. What IS generated is the hash SIDECAR: `{ id, version, kind,
// sha256 }` where sha256 is the hash of the artifact's exact bytes. It can't live inside the artifact
// (a file can't contain its own hash), and it must not live in `data/sounds/` either — the frontend
// seeds kits from an `@data/sounds/*.json` glob (`soundKits.ts`) and would mistake the sidecar for a
// kit. So it sits under `data/sound/` (singular), exactly as the UI twin sits under `data/ui/` rather
// than `data/components/`.
//
// This test is the generator + the drift guard: `UPDATE_KITS=1 npx vitest run signalKit.gen`
// (re)writes the sidecar; CI asserts it still matches the seed, so the packaged pin's id/version/hash
// are DERIVED, never hand-maintained. Both files are pinned `eol=lf` in .gitattributes so the bytes —
// and therefore the hash — are identical on every platform: the Rust `bsc sound release` store embeds
// both via `include_str!` as its packaged fallback entry (`crates/bsc-sound/src/release.rs`), and
// `packaged_sidecar_matches_the_embedded_artifact_and_the_generator_identity` there is the same guard
// from the Rust side. #3372's `PACKAGED_SOUND_KIT_PIN` reads this sidecar.
const FILE = join(process.cwd(), "src-tauri/data/sounds/signal.json");
const META_FILE = join(process.cwd(), "src-tauri/data/sound/signal-kit.meta.json");

/** The packaged kit's store identity — a publisher-scoped slug + an exact version, the shape
 *  `bsc sound release` validates and a blueprint pins. Mirrors `bsc/react-ui@1.0.0`. */
const SIGNAL_KIT_STORE_ID = "bsc/signal";
const SIGNAL_KIT_VERSION = "1.0.0";

/** The artifact's canonical (LF) bytes — a pre-.gitattributes checkout may still hold it CRLF, and LF
 *  is the byte form the recorded hash describes (the Rust embed normalizes identically). */
const artifact = readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");

const meta = {
  id: SIGNAL_KIT_STORE_ID,
  version: SIGNAL_KIT_VERSION,
  kind: "sound-kit",
  sha256: createHash("sha256").update(artifact, "utf8").digest("hex"),
};
const metaSerialised = JSON.stringify(meta, null, 2) + "\n";

describe("data/sound/signal-kit.meta.json ↔ data/sounds/signal.json (#3371)", () => {
  it("keeps the packaged sound-kit hash sidecar in sync (UPDATE_KITS=1 to regenerate)", () => {
    if (process.env.UPDATE_KITS) writeFileSync(META_FILE, metaSerialised);
    expect(
      existsSync(META_FILE),
      "signal-kit.meta.json missing — run `UPDATE_KITS=1 npx vitest run signalKit.gen`",
    ).toBe(true);
    expect(JSON.parse(readFileSync(META_FILE, "utf8"))).toEqual(meta);
  });

  it("records the hash of the artifact's exact canonical bytes", () => {
    const sidecar = JSON.parse(readFileSync(META_FILE, "utf8")) as { sha256: string };
    expect(createHash("sha256").update(artifact, "utf8").digest("hex")).toBe(sidecar.sha256);
  });

  it("carries the store identity the release store and the blueprint pin resolve against", () => {
    const sidecar = JSON.parse(readFileSync(META_FILE, "utf8")) as Record<string, string>;
    // A publisher-scoped slug + an exact version: the shape `bsc sound release` validates. A bare id
    // (`signal`) or a range would be rejected by the store, so pin the exact strings.
    expect(sidecar.id).toBe("bsc/signal");
    expect(sidecar.version).toBe("1.0.0");
    expect(sidecar.kind).toBe("sound-kit");
    expect(sidecar.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes a REAL kit — the artifact is the playable signal kit, not a stub", () => {
    // The release store refuses a hollow artifact (zero cues). Guard the seed itself so the packaged
    // entry can never become one: a kit with no cues maps to no UI sound at all.
    const kit = JSON.parse(artifact) as { id: string; cues: { id: string }[] };
    expect(kit.id).toBe("signal");
    expect(kit.cues.length).toBeGreaterThan(0);
  });
});
