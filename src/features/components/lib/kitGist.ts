// Component-kit gist transport (#2305 slice 1c) — publish/import a component KIT as a typed gist,
// reusing the SAME extension-manifest envelope + gist transport blueprints and app-state already use
// (#598/#2272). A kit is already a self-contained JSON file (slice 1b), so distribution is one file:
// wrap it in the `component-kit` envelope, publish it as a free GitHub gist (or copy a no-account
// share code), and import it back by URL/code. Pure envelope helpers (unit-testable) + Tauri-backed
// transport, mirroring `store/appStateGist.ts`.
import { wrapExtension, encodeShareCode, decodeShareCode, type ExtensionManifest, type ValidateResult } from "@/features/planner/lib/gist/manifest";
import { installFromGist, publishGist } from "@/features/planner/lib/gist/gist";
import { bsc } from "@/shared/lib/core/bsc";
import { sha256Hex } from "@/shared/lib/core/sha256";
import { DATA_SHAPES, ROLES, type ComponentRecord, type DataShape, type Kit, type PropSpec, type Role } from "./model";

/** The manifest kind a component kit ships as. */
export const KIT_KIND = "component-kit" as const;

/** The GLOBAL kit-store identity a published kit carries (#2465): the publisher-scoped id
 *  (`<publisher>/<kit-slug>`) + exact version it registers under in the versioned kit store —
 *  what an importer pins (`Blueprint.uiKit`) instead of re-deriving an identity per download. */
export interface KitStoreIdentity {
  id: string;
  version: string;
}

/** The kit + its components — the payload a `component-kit` gist carries. `store` (#2465) stamps
 *  the publisher's kit-store identity so every importer lands it under the SAME id@version. */
export interface KitPayload {
  kit: Kit;
  components: ComponentRecord[];
  store?: KitStoreIdentity;
}

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const role = (v: unknown): Role => (ROLES.includes(v as Role) ? (v as Role) : "primitive");

function coerceProp(v: unknown): PropSpec | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!str(o.name)) return null;
  return { name: str(o.name), type: str(o.type), req: o.req === true, desc: str(o.desc) };
}

/** Reconstruct a component from an untrusted payload, forcing it into `kitId` and dropping `builtin`
 *  (an imported record is user-owned). Returns null when it has no id/name. */
function coerceComponent(v: unknown, kitId: string): ComponentRecord | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const name = str(o.name);
  const id = str(o.id) || name.toLowerCase();
  if (!id || !name) return null;
  const rec: ComponentRecord = {
    id, name, kitId, role: role(o.role), version: str(o.version, "1.0.0"), used: num(o.used),
    tags: strArr(o.tags), variants: strArr(o.variants).length ? strArr(o.variants) : ["default"],
    composes: strArr(o.composes),
    props: Array.isArray(o.props) ? o.props.map(coerceProp).filter((p): p is PropSpec => p !== null) : [],
    whenUse: strArr(o.whenUse), whenNot: strArr(o.whenNot),
    src: str(o.src), srcText: str(o.srcText),
  };
  if (str(o.wraps)) rec.wraps = str(o.wraps);
  // The data-shape axis (#2475) rides a shared kit, filtered to the six-shape vocabulary.
  const shapes = strArr(o.shapes).filter((s): s is DataShape => (DATA_SHAPES as string[]).includes(s));
  if (shapes.length) rec.shapes = shapes;
  return rec;
}

/** Wrap a kit + its components in the typed extension envelope for publishing/sharing. `store`
 *  (#2465) stamps the payload with the publisher's kit-store identity (absent ⇒ the pre-#2465
 *  envelope, byte-identical). */
export function kitToManifest(kit: Kit, components: ComponentRecord[], version = "1.0.0", store?: KitStoreIdentity): ExtensionManifest<KitPayload> {
  const payload: KitPayload = { kit, components, ...(store ? { store } : {}) };
  return wrapExtension(KIT_KIND, kit.id, kit.name, version, payload, { description: `Component kit: ${kit.name}` });
}

/** Reconstruct a sanitized { kit, components } from a validated manifest, or an error if it's not a
 *  component kit. Components are forced into the kit's id; `builtin` is dropped so an imported kit is
 *  user-owned (deletable/editable) and can never masquerade as a packaged built-in. */
export function kitFromManifest(m: ExtensionManifest): { ok: true; kit: Kit; components: ComponentRecord[] } | { ok: false; error: string } {
  if (m.kind !== KIT_KIND) return { ok: false, error: `expected a component kit, got '${m.kind}'` };
  const p = (m.payload ?? {}) as Partial<KitPayload>;
  const rawKit = (p.kit ?? {}) as Record<string, unknown>;
  const id = str(rawKit.id) || str(m.id);
  const name = str(rawKit.name) || str(m.name);
  if (!id || !name) return { ok: false, error: "kit has no id or name" };
  const kit: Kit = { id, name, stack: str(rawKit.stack, "imported"), dot: str(rawKit.dot, "var(--accent)") };
  const components = (Array.isArray(p.components) ? p.components : [])
    .map((c) => coerceComponent(c, id))
    .filter((c): c is ComponentRecord => c !== null);
  if (!components.length) return { ok: false, error: "kit has no valid components" };
  return { ok: true, kit, components };
}

/** Encode a kit as a no-account, copy-paste share code (base64url of the manifest). */
export function kitShareCode(kit: Kit, components: ComponentRecord[]): string {
  return encodeShareCode(kitToManifest(kit, components));
}

/** Decode a share code OR a raw manifest JSON string back into a kit. */
export function kitFromCode(text: string): { ok: true; kit: Kit; components: ComponentRecord[] } | { ok: false; error: string } {
  const res: ValidateResult = decodeShareCode(text);
  return res.ok ? kitFromManifest(res.manifest) : res;
}

/** Import a kit from a gist URL/id (public gists need no auth; `token` raises the rate limit / reads a
 *  secret gist). Fetch → validate envelope → coerce the kit payload. */
export async function importKitFromGist(url: string, token = ""): Promise<{ ok: true; kit: Kit; components: ComponentRecord[] } | { ok: false; error: string }> {
  const res = await installFromGist(url, token);
  return res.ok ? kitFromManifest(res.manifest) : res;
}

/** The pin a published kit hands its consumers (#2465): the kit-store identity + the sha256 of the
 *  published manifest bytes, with the gist URL as `source` — exactly the `Blueprint.uiKit` shape. */
export interface PublishedKitPin {
  id: string;
  version: string;
  hash: string;
  source: string;
}

/** A lowercase [a-z0-9-] slug segment for the store identity. */
const idSlug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "kit";

/** Publish a kit as a gist (needs a token with the `gist` scope). `public` makes it a shareable public
 *  gist; the default is a secret gist. Returns the gist URL.
 *
 *  `publisher` (#2465) additionally registers the kit in the GLOBAL versioned kit store: the manifest
 *  is stamped with its store identity (`<publisher>/<kit-slug>@<version>`), hashed (sha256 of the
 *  EXACT bytes the gist holds), published, then written to the local store with the gist URL as
 *  `source` — so the publisher's own store entry, the gist bytes, and the returned `pin` all agree.
 *  A same-id@version conflict with different content is refused by the store (immutability) and
 *  surfaced as `warning` — the publish itself has already succeeded; bump `version` and re-publish. */
export async function publishKitToGist(
  token: string, kit: Kit, components: ComponentRecord[],
  opts: { public?: boolean; publisher?: string; version?: string } = {},
): Promise<{ ok: true; url: string; pin?: PublishedKitPin; warning?: string } | { ok: false; error: string }> {
  const store: KitStoreIdentity | undefined = opts.publisher
    ? { id: `${idSlug(opts.publisher)}/${idSlug(kit.id)}`, version: opts.version ?? "1.0.0" }
    : undefined;
  const manifest = kitToManifest(kit, components, store?.version ?? "1.0.0", store);
  try {
    const res = await publishGist(token, manifest, { public: opts.public });
    if (!store) return { ok: true, url: res.htmlUrl };
    // The bytes publishGist wrote (same object, same serialization) — the hash consumers verify.
    const text = JSON.stringify(manifest, null, 2);
    const pin: PublishedKitPin = { ...store, hash: await sha256Hex(text), source: res.htmlUrl };
    try {
      await bsc(
        null,
        ["ui", "release", "add", store.id, store.version, "--kind", KIT_KIND, "--sha256", pin.hash, "--source", res.htmlUrl],
        text,
      );
    } catch (e) {
      return { ok: true, url: res.htmlUrl, pin, warning: `published, but the local kit store refused ${store.id}@${store.version}: ${String(e)}` };
    }
    return { ok: true, url: res.htmlUrl, pin };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
