import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createHash, webcrypto } from "node:crypto";
import { kitToManifest, kitFromManifest, kitShareCode, kitFromCode, publishKitToGist, KIT_KIND, type KitPayload } from "./kitGist";
import { validateManifest, type ExtensionManifest } from "@/features/planner/lib/gist/manifest";
import type { ComponentRecord, Kit } from "./model";

// sha256Hex rides WebCrypto; back the jsdom env with Node's webcrypto when absent.
if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);

const kit: Kit = { id: "my-kit", name: "My Kit", stack: "React", dot: "var(--accent)", builtin: false };
const comps: ComponentRecord[] = [
  {
    id: "btn", name: "Btn", kitId: "my-kit", role: "primitive", version: "1.0.0", used: 3, tags: ["control"],
    variants: ["a"], composes: [], props: [{ name: "x", type: "string", req: true, desc: "d" }],
    whenUse: ["u"], whenNot: ["n"], src: "Btn.tsx", srcText: "code", wraps: "button",
  },
];

describe("component-kit gist envelope (#2305 slice 1c)", () => {
  it("round-trips a kit through the manifest", () => {
    const m = kitToManifest(kit, comps);
    expect(m.kind).toBe(KIT_KIND);
    expect(validateManifest(m).ok).toBe(true);
    const r = kitFromManifest(m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kit.id).toBe("my-kit");
    expect(r.components.map((c) => c.name)).toEqual(["Btn"]);
    expect(r.components[0].wraps).toBe("button");
  });

  it("round-trips through a no-account share code", () => {
    const r = kitFromCode(kitShareCode(kit, comps));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kit.name).toBe("My Kit");
  });

  it("rejects a non-kit manifest", () => {
    const bp = { manifest: 1, kind: "blueprint", id: "b", name: "B", version: "1", payload: {} } as unknown as ExtensionManifest;
    expect(kitFromManifest(bp).ok).toBe(false);
  });

  it("forces components into the kit id + drops builtin (never trusts the payload)", () => {
    const evil = kitToManifest({ ...kit, id: "react-ui" }, [{ ...comps[0], kitId: "other", builtin: true }]);
    const r = kitFromManifest(evil);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.components[0].kitId).toBe("react-ui");   // forced into the kit
    expect(r.components[0].builtin).toBeUndefined();  // an imported record is never a built-in
  });

  it("rejects a kit with no valid components", () => {
    expect(kitFromCode(kitShareCode(kit, [])).ok).toBe(false);
  });

  it("rides the data-shape axis through a share, filtered to the vocabulary (#2475)", () => {
    const stamped = { ...comps[0], shapes: ["list", "blob"] } as unknown as ComponentRecord;
    const r = kitFromManifest(kitToManifest(kit, [stamped]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // In-vocabulary shapes survive; the off-vocabulary token is dropped, never trusted.
    expect(r.components[0].shapes).toEqual(["list"]);
    // An unstamped component stays unstamped (no fabricated empty array).
    const r2 = kitFromManifest(kitToManifest(kit, comps));
    expect(r2.ok && r2.components[0].shapes).toBeUndefined();
  });
});

describe("publish with a kit-store identity (#2465)", () => {
  beforeEach(() => vi.mocked(invoke).mockClear());

  it("kitToManifest stamps `payload.store` only when given (pre-#2465 envelope stays byte-identical)", () => {
    const plain = kitToManifest(kit, comps);
    expect((plain.payload as KitPayload).store).toBeUndefined();
    expect("store" in (plain.payload as KitPayload)).toBe(false);
    const stamped = kitToManifest(kit, comps, "2.0.0", { id: "me/my-kit", version: "2.0.0" });
    expect((stamped.payload as KitPayload).store).toEqual({ id: "me/my-kit", version: "2.0.0" });
    expect(stamped.version).toBe("2.0.0");
    // The identity survives the payload coercion path untouched (kitFromManifest ignores it).
    expect(kitFromManifest(stamped).ok).toBe(true);
  });

  it("publishKitToGist(publisher) publishes, registers the store entry, and returns the pin", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "gist_create") return { id: "0123456789abcdef", html_url: "https://gist.github.com/me/0123456789abcdef" };
      if (cmd === "bsc") return "{}";
      return null;
    });
    const res = await publishKitToGist("tok", kit, comps, { public: true, publisher: "Me User" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warning).toBeUndefined();
    // The pin: slugged publisher-scoped id, the exact published bytes' sha256, the gist URL.
    const expectedText = JSON.stringify(kitToManifest(kit, comps, "1.0.0", { id: "me-user/my-kit", version: "1.0.0" }), null, 2);
    const expectedHash = createHash("sha256").update(expectedText, "utf8").digest("hex");
    expect(res.pin).toEqual({ id: "me-user/my-kit", version: "1.0.0", hash: expectedHash, source: res.url });
    // …and the local store got EXACTLY those bytes, verified by the same hash.
    const add = vi.mocked(invoke).mock.calls.find((c) => c[0] === "bsc")!;
    const { args, stdin } = add[1] as { args: string[]; stdin: string };
    expect(args).toEqual(["ui", "release", "add", "me-user/my-kit", "1.0.0", "--kind", KIT_KIND, "--sha256", expectedHash, "--source", res.url]);
    expect(stdin).toBe(expectedText);
  });

  it("a local-store refusal downgrades to a warning (the gist publish already succeeded)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "gist_create") return { id: "0123456789abcdef", html_url: "https://gist.github.com/me/0123456789abcdef" };
      if (cmd === "bsc") throw new Error("already exists with different content — published versions are immutable");
      return null;
    });
    const res = await publishKitToGist("tok", kit, comps, { publisher: "me" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.pin).toBeTruthy();
      expect(res.warning).toContain("immutable");
    }
  });

  it("without a publisher the legacy shape is preserved (no pin, no store write)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "gist_create") return { id: "0123456789abcdef", html_url: "https://gist.github.com/me/0123456789abcdef" };
      return null;
    });
    const res = await publishKitToGist("tok", kit, comps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pin).toBeUndefined();
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "bsc")).toBe(false);
  });
});
