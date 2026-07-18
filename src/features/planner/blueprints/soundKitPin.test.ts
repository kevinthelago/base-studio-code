// Sound-kit pin machinery tests (#3372): the packaged default pin, the default-pin on new-blueprint
// authoring (existing/no-pin blueprints unaffected), and the resolve flow — store hit ⇒ zero
// downloads · miss ⇒ fetch + sha256-verify BEFORE the store write · hash mismatch ⇒ loud rejection
// with nothing stored. The fetch (github_request) and the store (`bsc sound release …`) are both
// behind the mocked Tauri `invoke`, so every path is asserted at the wire — the round-trip through
// the generic `bsc` bridge (#2114) that the acceptance criteria call for.
//
// The sounds twin of uiKitPin.test.ts, plus the one divergence that matters: the artifact stored is
// the UNWRAPPED, canonicalized SoundKit payload (never the fetched envelope), so the hash a pin
// records is the hash of the kit object the Rust store validates.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createHash, webcrypto } from "node:crypto";
import packagedKitMeta from "@data/sound/signal-kit.meta.json";
import {
  packagedSoundKitPin, soundKitRef, resolveSoundKitPin, importSoundKitByGistUrl,
  deriveSoundKitIdentity, listStoreSoundKits, canonicalSoundArtifact,
} from "./soundKitPin";
import type { BlueprintSoundKit } from "../stages/blueprints";
import { makeBlueprints } from "../stages/blueprints";
import { useAppStore } from "@/store";

// sha256Hex rides WebCrypto; the jsdom test env may not expose `crypto.subtle` — back it with Node's
// webcrypto so the digests are the real thing (identical to the Rust store's sha2).
if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** A minimal but SHAPE-VALID sound kit — one cue, which is exactly what the Rust store's
 *  `validate_artifact` floor requires (a cue-less kit is a hollow release). */
const KIT = {
  id: "neon", name: "Neon",
  primitives: [{ id: "sine", name: "Sine", kind: "osc", waveform: "sine" }],
  voices: [{ id: "blip", name: "Blip", primitive: "sine" }],
  cues: [{ id: "click", name: "Click", layers: [{ voice: "blip" }] }],
};
/** The envelope a sound-kit gist ships: the kit rides as `payload`; identity/version ride the wrapper. */
const envelope = (over: Record<string, unknown> = {}, payload: unknown = KIT) =>
  JSON.stringify({ manifest: 1, kind: "sound-kit", id: "neon", name: "Neon", version: "2.0.0", payload, ...over }, null, 2);
/** What actually lands in the store: the payload alone, canonicalized. */
const ARTIFACT = canonicalSoundArtifact(KIT);

/** Route the mocked `invoke` — `bsc sound release get` returns `storeGet`, github_request returns
 *  `gist`, everything else null. Assertions read vi.mocked(invoke).mock.calls. */
function wire({ storeGet = null as unknown, gist = null as unknown } = {}) {
  vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
    const p = payload as { args?: string[] } | undefined;
    if (cmd === "bsc" && p?.args?.[0] === "sound" && p.args[1] === "release") {
      if (p.args[2] === "get") return JSON.stringify(storeGet);
      if (p.args[2] === "add") return JSON.stringify({ ok: true });
      if (p.args[2] === "list") return JSON.stringify(storeGet ? [storeGet] : []);
    }
    if (cmd === "github_request") return gist;
    return null;
  });
}

const addCalls = () =>
  vi.mocked(invoke).mock.calls.filter((c) => c[0] === "bsc" && (c[1] as { args?: string[] })?.args?.[2] === "add");
const fetchCalls = () => vi.mocked(invoke).mock.calls.filter((c) => c[0] === "github_request");

const GIST_URL = "https://gist.github.com/acme/0123456789abcdef";
const gistWith = (text: string, owner = "acme") => ({
  files: { "extension.json": { content: text, filename: "extension.json" } },
  owner: { login: owner },
});

beforeEach(() => {
  vi.mocked(invoke).mockClear();
});

describe("packaged default pin (#3372)", () => {
  it("mirrors the generated meta sidecar (id/version/hash) and mints fresh objects", () => {
    const pin = packagedSoundKitPin();
    expect(pin).toEqual({ id: packagedKitMeta.id, version: packagedKitMeta.version, hash: packagedKitMeta.sha256 });
    expect(pin.id).toBe("bsc/signal");
    expect(pin.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(packagedSoundKitPin()).not.toBe(pin); // fresh per call — pins never alias across blueprints
    expect(soundKitRef(pin)).toBe("bsc/signal@1.0.0");
  });

  it("carries NO themeId — a sound kit has no token contract to restyle", () => {
    expect(packagedSoundKitPin()).not.toHaveProperty("themeId");
  });
});

describe("canonicalSoundArtifact", () => {
  it("is the Rust assemble_artifact byte form: 2-space pretty + one trailing newline", () => {
    const text = canonicalSoundArtifact({ id: "k", cues: [] });
    expect(text).toBe('{\n  "id": "k",\n  "cues": []\n}\n');
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("default-pin on new-blueprint authoring", () => {
  it("addBlueprint pins the packaged sound kit; built-ins and no-pin imports stay unpinned", () => {
    useAppStore.setState({ blueprints: makeBlueprints(), activeBlueprintId: "default" });
    // Grandfathering: no built-in library blueprint grew a pin.
    for (const b of useAppStore.getState().blueprints) expect(b.soundKit).toBeUndefined();

    const id = useAppStore.getState().addBlueprint();
    const created = useAppStore.getState().blueprints.find((b) => b.id === id)!;
    expect(created.soundKit).toEqual(packagedSoundKitPin());
    // …alongside the UI pin: a new blueprint is fully specified on BOTH library pillars.
    expect(created.uiKit).toBeDefined();
    useAppStore.getState().removeBlueprint(id);

    // An imported blueprint WITHOUT a pin is untouched (no default injected after creation time)…
    const plain = useAppStore.getState().blueprints.find((b) => b.id === "default")!;
    const importedId = useAppStore.getState().importBlueprint(plain);
    expect(useAppStore.getState().blueprints.find((b) => b.id === importedId)!.soundKit).toBeUndefined();
    useAppStore.getState().removeBlueprint(importedId);

    // …and an imported blueprint WITH a pin keeps it verbatim.
    const pin: BlueprintSoundKit = { id: "acme/neon", version: "1.0.0", hash: sha256("x"), source: GIST_URL };
    const pinnedId = useAppStore.getState().importBlueprint({ ...plain, soundKit: pin });
    expect(useAppStore.getState().blueprints.find((b) => b.id === pinnedId)!.soundKit).toEqual(pin);
    useAppStore.getState().removeBlueprint(pinnedId);
  });

  it("opening a pinned blueprint fires the store resolve (setActiveBlueprint)", async () => {
    const plain = makeBlueprints().find((b) => b.id === "default")!;
    const pinned = { ...plain, id: "bp-pinned", soundKit: packagedSoundKitPin() };
    useAppStore.setState({ blueprints: [plain, pinned], activeBlueprintId: "default" });
    wire({ storeGet: { id: "bsc/signal", version: "1.0.0", sha256: packagedKitMeta.sha256, kind: "sound-kit", source: "packaged" } });
    useAppStore.getState().setActiveBlueprint("bp-pinned");
    await vi.waitFor(() => {
      const gets = vi.mocked(invoke).mock.calls.filter(
        (c) => c[0] === "bsc" && (c[1] as { args?: string[] })?.args?.[0] === "sound" && (c[1] as { args: string[] }).args[2] === "get",
      );
      expect(gets.length).toBeGreaterThan(0);
      expect((gets[0][1] as { args: string[] }).args).toEqual(["sound", "release", "get", "bsc/signal@1.0.0"]);
    });
    // The PACKAGED pin resolves offline: it's in the store via the embedded fallback, so zero
    // downloads and nothing added.
    expect(fetchCalls()).toHaveLength(0);
    expect(addCalls()).toHaveLength(0);
    useAppStore.setState({ activeBlueprintId: "default" });
  });
});

describe("resolveSoundKitPin — the resolve flow", () => {
  const pin = (): BlueprintSoundKit => ({ id: "acme/neon", version: "2.0.0", hash: sha256(ARTIFACT), source: GIST_URL });

  it("store hit ⇒ cached, never re-fetched", async () => {
    wire({ storeGet: { id: "acme/neon", version: "2.0.0", sha256: sha256(ARTIFACT), kind: "sound-kit" } });
    const res = await resolveSoundKitPin(pin());
    expect(res).toEqual({ ok: true, cached: true });
    expect(fetchCalls()).toHaveLength(0);
    expect(addCalls()).toHaveLength(0);
  });

  it("miss ⇒ fetches the source gist, verifies the hash, and writes the UNWRAPPED artifact", async () => {
    wire({ storeGet: null, gist: gistWith(envelope()) });
    const res = await resolveSoundKitPin(pin(), "tok");
    expect(res).toEqual({ ok: true, cached: false });
    expect(fetchCalls()).toHaveLength(1);
    const [, payload] = addCalls()[0];
    const { args, stdin } = payload as { args: string[]; stdin: string };
    expect(args).toEqual(["sound", "release", "add", "acme/neon", "2.0.0", "--kind", "sound-kit", "--sha256", sha256(ARTIFACT), "--source", GIST_URL]);
    // The kit OBJECT is what gets stored — not the envelope (which the Rust store would refuse for
    // having no top-level `cues`).
    expect(stdin).toBe(ARTIFACT);
    expect(JSON.parse(stdin)).toEqual(KIT);
    expect(stdin).not.toContain('"manifest"');
  });

  it("hash mismatch ⇒ loud rejection, store untouched", async () => {
    wire({ storeGet: null, gist: gistWith(envelope({}, { ...KIT, name: "Tampered" })) });
    const res = await resolveSoundKitPin(pin());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/REJECTED.*refusing to store/s);
    expect(addCalls()).toHaveLength(0);
  });

  it("miss without a source ⇒ a loud, actionable error", async () => {
    wire({ storeGet: null });
    const noSource: BlueprintSoundKit = { id: "acme/neon", version: "2.0.0", hash: sha256(ARTIFACT) };
    const res = await resolveSoundKitPin(noSource);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("no source");
    expect(fetchCalls()).toHaveLength(0);
  });

  it("a source gist that isn't a sound kit is refused before any store write", async () => {
    wire({ storeGet: null, gist: gistWith(JSON.stringify({ manifest: 1, kind: "component-kit", id: "x", name: "X", version: "1", payload: {} })) });
    const res = await resolveSoundKitPin(pin());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("not a sound kit");
    expect(addCalls()).toHaveLength(0);
  });

  it("a store-write refusal (immutability) surfaces instead of passing silently", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
      const p = payload as { args?: string[] } | undefined;
      if (cmd === "bsc" && p?.args?.[2] === "get") return "null";
      if (cmd === "bsc" && p?.args?.[2] === "add") throw new Error("already exists with different content");
      if (cmd === "github_request") return gistWith(envelope());
      return null;
    });
    const res = await resolveSoundKitPin(pin());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("could not be stored");
  });
});

describe("importSoundKitByGistUrl — the picker's import path", () => {
  it("adds to the store under the STAMPED identity and returns the matching pin", async () => {
    const text = envelope({ store: { id: "acme/neon", version: "3.1.0" } });
    wire({ storeGet: null, gist: gistWith(text) });
    const res = await importSoundKitByGistUrl(GIST_URL);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pin).toEqual({ id: "acme/neon", version: "3.1.0", hash: sha256(ARTIFACT), source: GIST_URL });
    const { args, stdin } = addCalls()[0][1] as { args: string[]; stdin: string };
    expect(args.slice(2, 5)).toEqual(["add", "acme/neon", "3.1.0"]);
    expect(stdin).toBe(ARTIFACT);
  });

  it("the imported pin round-trips: resolving it against the store it just wrote is a cache hit", async () => {
    wire({ storeGet: null, gist: gistWith(envelope()) });
    const imported = await importSoundKitByGistUrl(GIST_URL);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    // Now the store HAS it — the exact manifest `bsc sound release add` would have persisted.
    wire({ storeGet: { id: imported.pin.id, version: imported.pin.version, sha256: imported.pin.hash, kind: "sound-kit", source: GIST_URL } });
    vi.mocked(invoke).mockClear(); // count only the RESOLVE's traffic, not the import's

    expect(await resolveSoundKitPin(imported.pin)).toEqual({ ok: true, cached: true });
    expect(fetchCalls()).toHaveLength(0);
  });

  it("falls back to <owner>/<kit-id> for a gist with no stamped identity", async () => {
    wire({ storeGet: null, gist: gistWith(envelope(), "Acme Corp") });
    const res = await importSoundKitByGistUrl(GIST_URL);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pin).toMatchObject({ id: "acme-corp/neon", version: "2.0.0" });
  });

  it("rejects a gist that is not a sound kit", async () => {
    const text = JSON.stringify({ manifest: 1, kind: "blueprint", id: "b", name: "B", version: "1", payload: {} });
    wire({ storeGet: null, gist: gistWith(text) });
    const res = await importSoundKitByGistUrl(GIST_URL);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("not a sound kit");
    expect(addCalls()).toHaveLength(0);
  });

  it("rejects a HOLLOW kit (zero cues) before the store ever sees it", async () => {
    wire({ storeGet: null, gist: gistWith(envelope({}, { ...KIT, cues: [] })) });
    const res = await importSoundKitByGistUrl(GIST_URL);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("no cues");
    expect(addCalls()).toHaveLength(0);
  });

  it("deriveSoundKitIdentity prefers a VALID stamped identity, else slugs owner/kit-id", () => {
    expect(deriveSoundKitIdentity({ id: "neon", version: "1.2.3", store: { id: "acme/neon", version: "9.0.0" }, payload: KIT }, "other"))
      .toEqual({ id: "acme/neon", version: "9.0.0" });
    // An invalid stamped id (not publisher-scoped) falls back to the derived one.
    expect(deriveSoundKitIdentity({ id: "neon", version: "1.2.3", store: { id: "NOT VALID" }, payload: KIT }, "Acme"))
      .toEqual({ id: "acme/neon", version: "1.2.3" });
    // No payload id ⇒ the envelope id names it; no version anywhere ⇒ 1.0.0.
    expect(deriveSoundKitIdentity({ id: "My Kit!" }, undefined)).toEqual({ id: "gist/my-kit", version: "1.0.0" });
  });
});

describe("listStoreSoundKits", () => {
  it("parses the bridge list and degrades to [] when the bridge is absent", async () => {
    const entry = { id: "bsc/signal", version: "1.0.0", sha256: "h", kind: "sound-kit", source: "packaged" };
    wire({ storeGet: entry });
    expect(await listStoreSoundKits()).toEqual([entry]);
    vi.mocked(invoke).mockRejectedValue(new Error("no bridge"));
    expect(await listStoreSoundKits()).toEqual([]);
  });
});
