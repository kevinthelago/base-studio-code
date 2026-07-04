// Component-kit gist transport (#2305 slice 1c) — publish/import a component KIT as a typed gist,
// reusing the SAME extension-manifest envelope + gist transport blueprints and app-state already use
// (#598/#2272). A kit is already a self-contained JSON file (slice 1b), so distribution is one file:
// wrap it in the `component-kit` envelope, publish it as a free GitHub gist (or copy a no-account
// share code), and import it back by URL/code. Pure envelope helpers (unit-testable) + Tauri-backed
// transport, mirroring `store/appStateGist.ts`.
import { wrapExtension, encodeShareCode, decodeShareCode, type ExtensionManifest, type ValidateResult } from "@/features/planner/lib/gist/manifest";
import { installFromGist, publishGist } from "@/features/planner/lib/gist/gist";
import { ROLES, type ComponentRecord, type Kit, type PropSpec, type Role } from "./model";

/** The manifest kind a component kit ships as. */
export const KIT_KIND = "component-kit" as const;

/** The kit + its components — the payload a `component-kit` gist carries. */
export interface KitPayload {
  kit: Kit;
  components: ComponentRecord[];
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
  return rec;
}

/** Wrap a kit + its components in the typed extension envelope for publishing/sharing. */
export function kitToManifest(kit: Kit, components: ComponentRecord[], version = "1.0.0"): ExtensionManifest<KitPayload> {
  return wrapExtension(KIT_KIND, kit.id, kit.name, version, { kit, components }, { description: `Component kit: ${kit.name}` });
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

/** Publish a kit as a gist (needs a token with the `gist` scope). `public` makes it a shareable public
 *  gist; the default is a secret gist. Returns the gist URL. */
export async function publishKitToGist(token: string, kit: Kit, components: ComponentRecord[], opts: { public?: boolean } = {}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    const res = await publishGist(token, kitToManifest(kit, components), { public: opts.public });
    return { ok: true, url: res.htmlUrl };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
