// Generic ExtensionManifest envelope for distributable extension artifacts —
// blueprints now, pipelines and MCP-install manifests in later milestones.
//
// Free of React / Tauri / store imports so it can be unit-tested in isolation.

export type ManifestKind = "blueprint" | "pipeline" | "mcp-extension";

/** The envelope wrapping any distributable extension artifact. */
export interface ExtensionManifest {
  kind: ManifestKind;
  /** Stable identifier carried from the original (not re-minted on import). */
  id: string;
  name: string;
  /** Monotonic version string ("1", "2", "1.0.0", …). */
  version: string;
  /** Reserved for M3: capability consent gates ("read-signals", "write-files", …). */
  capabilities?: string[];
  /** Reserved for M2/M3: sha256 of the serialized payload for integrity pinning. */
  integrity?: string;
  /** Kind-specific data. */
  payload: unknown;
}

// ── Blueprint ─────────────────────────────────────────────────────────────────

/** A reusable project planning template stored in the local library. */
export interface Blueprint {
  id: string;
  name: string;
  description: string;
  /** Plan section content keyed by section key (e.g. "goal", "stack"). */
  sections: Record<string, string>;
  /** Raw phases.json content, if any. */
  phases?: string;
  createdAt: number;
  updatedAt: number;
}

/** The payload shape inside a blueprint manifest. */
export interface BlueprintPayload {
  description: string;
  sections: Record<string, string>;
  phases?: string;
}

// ── Validation ────────────────────────────────────────────────────────────────

const VALID_KINDS: ManifestKind[] = ["blueprint", "pipeline", "mcp-extension"];

/** True iff `raw` has all required manifest fields with the right types. */
export function validateManifest(raw: unknown): raw is ExtensionManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o.kind === "string" &&
    VALID_KINDS.includes(o.kind as ManifestKind) &&
    typeof o.id === "string" && o.id.length > 0 &&
    typeof o.name === "string" && o.name.length > 0 &&
    typeof o.version === "string" && o.version.length > 0 &&
    "payload" in o
  );
}

/** Parse an arbitrary value into an ExtensionManifest, or null if invalid. */
export function parseManifest(raw: unknown): ExtensionManifest | null {
  if (!validateManifest(raw)) return null;
  const o = raw as unknown as Record<string, unknown>;
  const m: ExtensionManifest = {
    kind: o.kind as ManifestKind,
    id: o.id as string,
    name: o.name as string,
    version: o.version as string,
    payload: o.payload,
  };
  if (Array.isArray(o.capabilities)) {
    m.capabilities = (o.capabilities as unknown[]).filter((c): c is string => typeof c === "string");
  }
  if (typeof o.integrity === "string" && o.integrity.length > 0) {
    m.integrity = o.integrity;
  }
  return m;
}

// ── Share-code encode / decode ────────────────────────────────────────────────
// A share-code is URL-safe base64 of the manifest JSON. It can be pasted into
// the import dialog or appended to a `bsc://install-extension` deep link (M2+).

/** Encode a manifest to a compact, URL-safe share-code string. */
export function encodeShareCode(manifest: ExtensionManifest): string {
  const json = JSON.stringify(manifest);
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a share-code back to a manifest, or null if malformed or invalid. */
export function decodeShareCode(code: string): ExtensionManifest | null {
  try {
    const b64 = code.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    return parseManifest(JSON.parse(json));
  } catch {
    return null;
  }
}

// ── Blueprint ↔ manifest ──────────────────────────────────────────────────────

/** Wrap a Blueprint in a distributable ExtensionManifest envelope. */
export function blueprintToManifest(bp: Blueprint): ExtensionManifest {
  const payload: BlueprintPayload = {
    description: bp.description,
    sections: { ...bp.sections },
    ...(bp.phases !== undefined ? { phases: bp.phases } : {}),
  };
  return { kind: "blueprint", id: bp.id, name: bp.name, version: "1", payload };
}

/**
 * Unwrap a blueprint manifest into a Blueprint (re-minting timestamps with `now`).
 * Returns null if the manifest is not a blueprint or the payload is structurally wrong.
 */
export function manifestToBlueprint(manifest: ExtensionManifest, now = Date.now()): Blueprint | null {
  if (manifest.kind !== "blueprint") return null;
  const p = manifest.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const po = p as Record<string, unknown>;
  const rawSections = po.sections;
  const sections =
    rawSections && typeof rawSections === "object" && !Array.isArray(rawSections)
      ? Object.fromEntries(
          Object.entries(rawSections as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string")
            .map(([k, v]) => [k, v as string]),
        )
      : {};
  return {
    id: manifest.id,
    name: manifest.name,
    description: typeof po.description === "string" ? po.description : "",
    sections,
    ...(typeof po.phases === "string" ? { phases: po.phases } : {}),
    createdAt: now,
    updatedAt: now,
  };
}
