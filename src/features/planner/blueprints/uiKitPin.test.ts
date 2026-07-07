// UI-kit pin machinery tests (#2465): the packaged default pin, the default-pin on new-blueprint
// authoring (existing/no-pin blueprints unaffected), and the resolve flow — store hit ⇒ zero
// downloads · miss ⇒ fetch + sha256-verify BEFORE the store write · hash mismatch ⇒ loud rejection
// with nothing stored. The fetch (github_request) and the store (`bsc ui release …`) are both behind
// the mocked Tauri `invoke`, so every path is asserted at the wire.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createHash, webcrypto } from "node:crypto";
import packagedKitMeta from "@data/ui/react-ui-kit.meta.json";
import {
  packagedUiKitPin, kitRef, resolveUiKitPin, importKitByGistUrl, deriveKitIdentity, listStoreKits,
} from "./uiKitPin";
import type { BlueprintUiKit } from "../stages/blueprints";
import { makeBlueprints } from "../stages/blueprints";
import { useAppStore } from "@/store";

// sha256Hex rides WebCrypto; the jsdom test env may not expose `crypto.subtle` — back it with
// Node's webcrypto so the digests are the real thing (identical to the Rust store's sha2).
if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Route the mocked `invoke` — `bsc ui release get` returns `storeGet`, github_request returns `gist`,
 *  everything else null. Records nothing itself; assertions read vi.mocked(invoke).mock.calls. */
function wire({ storeGet = null as unknown, gist = null as unknown } = {}) {
  vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
    const p = payload as { args?: string[] } | undefined;
    if (cmd === "bsc" && p?.args?.[0] === "ui" && p.args[1] === "release") {
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

describe("packaged default pin (#2465)", () => {
  it("mirrors the generated meta sidecar (id/version/hash) and mints fresh objects", () => {
    const pin = packagedUiKitPin();
    expect(pin).toEqual({ id: packagedKitMeta.id, version: packagedKitMeta.version, hash: packagedKitMeta.sha256 });
    expect(pin.id).toBe("bsc/react-ui");
    expect(pin.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(packagedUiKitPin()).not.toBe(pin); // fresh per call — pins never alias across blueprints
    expect(kitRef(pin)).toBe("bsc/react-ui@1.0.0");
  });
});

describe("default-pin on new-blueprint authoring", () => {
  it("addBlueprint pins the packaged kit; built-ins and no-pin imports stay unpinned", () => {
    useAppStore.setState({ blueprints: makeBlueprints(), activeBlueprintId: "default" });
    // Grandfathering: no built-in library blueprint grew a pin.
    for (const b of useAppStore.getState().blueprints) expect(b.uiKit).toBeUndefined();

    const id = useAppStore.getState().addBlueprint();
    const created = useAppStore.getState().blueprints.find((b) => b.id === id)!;
    expect(created.uiKit).toEqual(packagedUiKitPin());
    useAppStore.getState().removeBlueprint(id);

    // An imported blueprint WITHOUT a pin is untouched (no default injected after creation time)…
    const plain = useAppStore.getState().blueprints.find((b) => b.id === "default")!;
    const importedId = useAppStore.getState().importBlueprint(plain);
    expect(useAppStore.getState().blueprints.find((b) => b.id === importedId)!.uiKit).toBeUndefined();
    useAppStore.getState().removeBlueprint(importedId);

    // …and an imported blueprint WITH a pin keeps it verbatim.
    const pin: BlueprintUiKit = { id: "acme/neon", version: "1.0.0", hash: sha256("x"), source: GIST_URL };
    const pinnedId = useAppStore.getState().importBlueprint({ ...plain, uiKit: pin });
    expect(useAppStore.getState().blueprints.find((b) => b.id === pinnedId)!.uiKit).toEqual(pin);
    useAppStore.getState().removeBlueprint(pinnedId);
  });

  it("opening a pinned blueprint fires the store resolve (setActiveBlueprint)", async () => {
    const plain = makeBlueprints().find((b) => b.id === "default")!;
    const pinned = { ...plain, id: "bp-pinned", uiKit: packagedUiKitPin() };
    useAppStore.setState({ blueprints: [plain, pinned], activeBlueprintId: "default" });
    wire({ storeGet: { id: "bsc/react-ui", version: "1.0.0", sha256: packagedKitMeta.sha256, kind: "component-kit", source: "packaged" } });
    useAppStore.getState().setActiveBlueprint("bp-pinned");
    await vi.waitFor(() => {
      const gets = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "bsc" && (c[1] as { args?: string[] })?.args?.[2] === "get");
      expect(gets.length).toBeGreaterThan(0);
      expect((gets[0][1] as { args: string[] }).args).toEqual(["ui", "release", "get", "bsc/react-ui@1.0.0"]);
    });
    // Cached in the store ⇒ zero downloads, nothing added.
    expect(fetchCalls()).toHaveLength(0);
    expect(addCalls()).toHaveLength(0);
    useAppStore.setState({ activeBlueprintId: "default" });
  });
});

describe("resolveUiKitPin — the resolve flow", () => {
  const text = JSON.stringify({ manifest: 1, kind: "component-kit", id: "neon", name: "Neon", version: "2.0.0", payload: {} }, null, 2);
  const pin = (): BlueprintUiKit => ({ id: "acme/neon", version: "2.0.0", hash: sha256(text), source: GIST_URL });

  it("store hit ⇒ cached, never re-fetched", async () => {
    wire({ storeGet: { id: "acme/neon", version: "2.0.0", sha256: sha256(text), kind: "component-kit" } });
    const res = await resolveUiKitPin(pin());
    expect(res).toEqual({ ok: true, cached: true });
    expect(fetchCalls()).toHaveLength(0);
    expect(addCalls()).toHaveLength(0);
  });

  it("miss ⇒ fetches the source gist, verifies the hash, and writes the store entry", async () => {
    wire({ storeGet: null, gist: gistWith(text) });
    const res = await resolveUiKitPin(pin(), "tok");
    expect(res).toEqual({ ok: true, cached: false });
    expect(fetchCalls()).toHaveLength(1);
    const [, payload] = addCalls()[0];
    const { args, stdin } = payload as { args: string[]; stdin: string };
    expect(args).toEqual(["ui", "release", "add", "acme/neon", "2.0.0", "--kind", "component-kit", "--sha256", sha256(text), "--source", GIST_URL]);
    expect(stdin).toBe(text); // the EXACT fetched bytes are what gets stored
  });

  it("hash mismatch ⇒ loud rejection, store untouched", async () => {
    wire({ storeGet: null, gist: gistWith(text + "tampered") });
    const res = await resolveUiKitPin(pin());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/REJECTED.*refusing to store/s);
    expect(addCalls()).toHaveLength(0);
  });

  it("miss without a source ⇒ a loud, actionable error", async () => {
    wire({ storeGet: null });
    const noSource: BlueprintUiKit = { id: "acme/neon", version: "2.0.0", hash: sha256(text) };
    const res = await resolveUiKitPin(noSource);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("no source");
    expect(fetchCalls()).toHaveLength(0);
  });

  it("a store-write refusal (immutability) surfaces instead of passing silently", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
      const p = payload as { args?: string[] } | undefined;
      if (cmd === "bsc" && p?.args?.[2] === "get") return "null";
      if (cmd === "bsc" && p?.args?.[2] === "add") throw new Error("already exists with different content");
      if (cmd === "github_request") return gistWith(text);
      return null;
    });
    const res = await resolveUiKitPin(pin());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("could not be stored");
  });
});

describe("importKitByGistUrl — the picker's import path", () => {
  const kitManifest = (extra: object = {}) =>
    JSON.stringify({
      manifest: 1, kind: "component-kit", id: "neon", name: "Neon", version: "3.1.0",
      payload: { kit: { id: "neon", name: "Neon" }, components: [], ...extra },
    }, null, 2);

  it("adds to the store under the STAMPED identity and returns the matching pin", async () => {
    const text = kitManifest({ store: { id: "acme/neon", version: "3.1.0" } });
    wire({ storeGet: null, gist: gistWith(text) });
    const res = await importKitByGistUrl(GIST_URL);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pin).toEqual({ id: "acme/neon", version: "3.1.0", hash: sha256(text), source: GIST_URL });
    const { args, stdin } = addCalls()[0][1] as { args: string[]; stdin: string };
    expect(args.slice(2, 5)).toEqual(["add", "acme/neon", "3.1.0"]);
    expect(stdin).toBe(text);
  });

  it("falls back to <owner>/<manifest-id> for a pre-#2465 kit gist", async () => {
    const text = kitManifest();
    wire({ storeGet: null, gist: gistWith(text, "Acme Corp") });
    const res = await importKitByGistUrl(GIST_URL);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pin.id).toBe("acme-corp/neon");
  });

  it("rejects a gist that is not a component kit", async () => {
    const text = JSON.stringify({ manifest: 1, kind: "blueprint", id: "b", name: "B", version: "1", payload: {} });
    wire({ storeGet: null, gist: gistWith(text) });
    const res = await importKitByGistUrl(GIST_URL);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("not a component kit");
    expect(addCalls()).toHaveLength(0);
  });

  it("deriveKitIdentity prefers a VALID stamped identity, else slugs owner/id", () => {
    expect(deriveKitIdentity({ id: "neon", version: "1.2.3", payload: { store: { id: "acme/neon", version: "9.0.0" } } }, "other"))
      .toEqual({ id: "acme/neon", version: "9.0.0" });
    // An invalid stamped id (not publisher-scoped) falls back to the derived one.
    expect(deriveKitIdentity({ id: "neon", version: "1.2.3", payload: { store: { id: "NOT VALID" } } }, "Acme"))
      .toEqual({ id: "acme/neon", version: "1.2.3" });
    expect(deriveKitIdentity({ id: "My Kit!" }, undefined)).toEqual({ id: "gist/my-kit", version: "1.0.0" });
  });
});

describe("listStoreKits", () => {
  it("parses the bridge list and degrades to [] when the bridge is absent", async () => {
    wire({ storeGet: { id: "bsc/react-ui", version: "1.0.0", sha256: "h", kind: "component-kit", source: "packaged" } });
    expect(await listStoreKits()).toEqual([{ id: "bsc/react-ui", version: "1.0.0", sha256: "h", kind: "component-kit", source: "packaged" }]);
    vi.mocked(invoke).mockRejectedValue(new Error("no bridge"));
    expect(await listStoreKits()).toEqual([]);
  });
});
