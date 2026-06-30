// Migration SOURCE planner-channel coercion (forward-compat) — lenient parsing of a `<source_config>`
// payload into a SourceConfig. The planner can PROPOSE sources from the pitch and pre-fill non-secret
// connection hints; it can never supply a secret (those are entered on-device), so any secret-looking
// field is dropped and a coerced source is never trusted as already-connected. Split out of
// sourceValidate.ts (#1712). The native catalog is gone (#1976), so any connector id is accepted.

import type { DeclaredSource, SourceConfig, SourceStatus } from "./sourceSpecs";

type Raw = Record<string, unknown>;
const asStr = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const asArr = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((x): x is Raw => !!x && typeof x === "object") : []);
const STATUSES: SourceStatus[] = ["declared", "connecting", "scanning", "scanned", "error"];

// With the static connector catalog gone (#1976), connectors are agent-authored and we no longer
// know each one's secret fields up front. The planner channel still must never carry a secret, so any
// field whose KEY looks credential-bearing is dropped generically (the value stays on-device).
const SECRET_KEY = /token|secret|passw(or)?d|api[_-]?key|access|credential/i;

export function coerceSourceConfig(raw: unknown): SourceConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Raw;
  // Every proposed id is a valid agent-authored connector id now — keep any non-empty string.
  const proposed = (Array.isArray(o.proposed) ? o.proposed : [])
    .map((x) => asStr(x))
    .filter(Boolean);
  const sources: DeclaredSource[] = asArr(o.sources).map((s, i) => {
    const connectorId = asStr(s.connectorId) || "source";
    const rawFields = (s.fields && typeof s.fields === "object" ? s.fields : {}) as Raw;
    const fields: Record<string, string> = {};
    // Keep only NON-SECRET field hints — a secret can never be carried in over the channel.
    for (const [k, v] of Object.entries(rawFields)) {
      if (!SECRET_KEY.test(k) && typeof v === "string") fields[k] = v;
    }
    const status = STATUSES.includes(asStr(s.status) as SourceStatus) ? (asStr(s.status) as SourceStatus) : "declared";
    return {
      uid: asStr(s.uid) || `src-${connectorId}-${i}`,
      connectorId,
      instance: asStr(s.instance) || undefined,
      env: s.env === "sandbox" ? "sandbox" : s.env === "production" ? "production" : undefined,
      // A coerced source is never trusted as already-connected — credentials are entered on-device,
      // so anything past `declared` resets to `declared` (the user must connect it here).
      status: status === "error" ? "error" : "declared",
      fields,
    };
  });
  return { dataModelName: asStr(o.dataModelName) || asStr((o.dataModel as Raw)?.name), proposed, sources };
}

/** Parse a `<source_config>` tag body into a SourceConfig (forgiving: extracts the outermost JSON
 *  object, tolerates wrapping prose). Returns null if no JSON object is present. */
export function parseSourceConfigTag(body: string): SourceConfig | null {
  const json = body.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    return coerceSourceConfig(JSON.parse(json));
  } catch {
    try {
      return coerceSourceConfig(JSON.parse(json.replace(/[ \t]*[\r\n]+[ \t]*/g, " ")));
    } catch {
      return null;
    }
  }
}
