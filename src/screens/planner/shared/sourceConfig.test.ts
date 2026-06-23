import { describe, it, expect } from "vitest";
import {
  CONNECTORS, connector, defaultSourceConfig, newDeclaredSource, sampleScan, redactedHandle,
  isConnected, connectedCount, allSourcesConnected, sourceChecks, coerceSourceConfig, parseSourceConfigTag,
  deriveDataModel, migrationActive, datamodelSignals, downstreamImpact,
  type DeclaredSource, type SourceConfig,
} from "./sourceConfig";
import { checkDataModel } from "../data/dataModel";

const src = (over: Partial<DeclaredSource>): DeclaredSource => ({ uid: "u", connectorId: "quickbase", status: "declared", fields: {}, ...over });

describe("sourceConfig — catalog", () => {
  it("has the expected first-party connectors with specs", () => {
    const ids = CONNECTORS.map((c) => c.id);
    expect(ids).toContain("quickbooks");
    expect(ids).toContain("quickbase");
    expect(ids).toContain("salesforce");
    // QuickBooks is OAuth (no fields); Quickbase is a token form with a secret field.
    expect(connector("quickbooks").spec.auth).toBe("oauth");
    const qb = connector("quickbase").spec;
    expect(qb.auth).toBe("token");
    expect(qb.fields.some((f) => f.secret)).toBe(true);
  });

  it("connector() falls back safely for an unknown id", () => {
    const c = connector("nope");
    expect(c.id).toBe("nope");
    expect(c.spec.fields).toEqual([]);
  });
});

describe("sourceConfig — gate + counts", () => {
  it("newDeclaredSource starts as declared with no fields", () => {
    const s = newDeclaredSource("quickbase", "u1");
    expect(s.status).toBe("declared");
    expect(s.fields).toEqual({});
  });

  it("isConnected + connectedCount count scanning and scanned", () => {
    expect(isConnected(src({ status: "scanned" }))).toBe(true);
    expect(isConnected(src({ status: "scanning" }))).toBe(true);
    expect(isConnected(src({ status: "declared" }))).toBe(false);
    const cfg = { dataModelName: "", proposed: [], sources: [src({ uid: "a", status: "scanned" }), src({ uid: "b", status: "connecting" })] };
    expect(connectedCount(cfg)).toBe(1);
  });

  it("allSourcesConnected: empty ⇒ false, all scanned ⇒ true, any non-scanned ⇒ false", () => {
    expect(allSourcesConnected(defaultSourceConfig())).toBe(false);
    expect(allSourcesConnected(undefined)).toBe(false);
    expect(allSourcesConnected({ dataModelName: "", proposed: [], sources: [src({ uid: "a", status: "scanned" })] })).toBe(true);
    expect(allSourcesConnected({ dataModelName: "", proposed: [], sources: [src({ uid: "a", status: "scanned" }), src({ uid: "b", status: "declared" })] })).toBe(false);
    expect(allSourcesConnected({ dataModelName: "", proposed: [], sources: [src({ uid: "a", status: "error" })] })).toBe(false);
  });

  it("sourceChecks reflect declared / connected / errored", () => {
    const cfg = { dataModelName: "", proposed: [], sources: [src({ uid: "a", status: "scanned" }), src({ uid: "b", status: "error" })] };
    const byId = Object.fromEntries(sourceChecks(cfg).map((c) => [c.id, c.ok]));
    expect(byId.declared).toBe(true);
    expect(byId.connected).toBe(false); // not all scanned
    expect(byId.healthy).toBe(false);   // one errored
  });
});

describe("sourceConfig — scan samples + handle", () => {
  it("returns known samples and a safe fallback", () => {
    expect(sampleScan("quickbase").objects.some((o) => o.name === "Projects")).toBe(true);
    expect(sampleScan("totally-unknown").objects.length).toBeGreaterThan(0);
  });

  it("redactedHandle is instance + env, never a credential", () => {
    expect(redactedHandle(src({ connectorId: "quickbase", instance: "acme realm", env: "production" }))).toBe("acme realm · production · held by app");
    expect(redactedHandle(src({ connectorId: "quickbooks" }))).toBe("QuickBooks · held by app");
  });
});

describe("sourceConfig — coercion (planner channel)", () => {
  it("keeps non-secret field hints but DROPS any secret, and resets status to declared", () => {
    const cfg = coerceSourceConfig({
      dataModelName: "Acme Core",
      proposed: ["quickbooks", "not-a-connector"],
      sources: [{ connectorId: "quickbase", status: "scanned", fields: { realm: "acme.quickbase.com", userToken: "SECRET-LEAK" } }],
    });
    expect(cfg.dataModelName).toBe("Acme Core");
    expect(cfg.proposed).toEqual(["quickbooks"]); // unknown connector filtered out
    expect(cfg.sources[0].fields.realm).toBe("acme.quickbase.com");
    expect(cfg.sources[0].fields.userToken).toBeUndefined(); // secret never carried over the channel
    expect(cfg.sources[0].status).toBe("declared"); // never trusted as pre-connected
  });

  it("parseSourceConfigTag extracts JSON and returns null when absent", () => {
    expect(parseSourceConfigTag("blah no json here")).toBeNull();
    const parsed = parseSourceConfigTag('prose { "proposed": ["salesforce"] } trailing');
    expect(parsed?.proposed).toEqual(["salesforce"]);
  });
});

describe("sourceConfig — derive model + downstream (#1205)", () => {
  const scannedCfg: SourceConfig = {
    dataModelName: "Acme Core",
    proposed: [],
    sources: [
      src({
        uid: "a", connectorId: "quickbase", status: "scanned",
        objects: [{ name: "Projects", count: 12, fields: ["Name", "Budget"] }, { name: "Tickets", count: 5 }],
        behaviors: [{ label: "form rule" }, { label: "Pipeline" }],
      }),
      // A not-yet-scanned source contributes nothing to the derived model.
      src({ uid: "b", connectorId: "salesforce", status: "declared" }),
    ],
  };

  it("migrationActive: ≥1 declared source", () => {
    expect(migrationActive(undefined)).toBe(false);
    expect(migrationActive(defaultSourceConfig())).toBe(false);
    expect(migrationActive(scannedCfg)).toBe(true);
  });

  it("deriveDataModel builds entities from scanned objects; fields from columns or a default id", () => {
    const m = deriveDataModel(scannedCfg, "dm-x");
    expect(m.id).toBe("dm-x");
    expect(m.name).toBe("Acme Core");
    expect(m.entities.length).toBe(2); // only the scanned source's objects

    const proj = m.entities.find((e) => e.key === "projects")!;
    expect(proj.fields.map((f) => f.key)).toEqual(["name", "budget"]);
    expect(proj.identity).toEqual(["name"]); // no "id" column ⇒ first field is the identity

    const tick = m.entities.find((e) => e.key === "tickets")!;
    expect(tick.fields.map((f) => f.key)).toEqual(["id"]); // no columns ⇒ default id
    expect(tick.identity).toEqual(["id"]);
  });

  it("the derived model is structurally valid", () => {
    expect(checkDataModel(deriveDataModel(scannedCfg))).toEqual([]);
  });

  it("datamodelSignals reflect scan progress", () => {
    expect(datamodelSignals(undefined)).toEqual({ sourceReachable: false, modelInferred: false, schemaRefined: false });
    // one scanned + one declared ⇒ reachable + inferred, but not refined (not all scanned)
    expect(datamodelSignals(scannedCfg)).toEqual({ sourceReachable: true, modelInferred: true, schemaRefined: false });
    expect(datamodelSignals({ ...scannedCfg, sources: [scannedCfg.sources[0]] }).schemaRefined).toBe(true);
  });

  it("downstreamImpact counts entities, fields, and behaviors", () => {
    const imp = downstreamImpact(scannedCfg);
    expect(imp.entities).toBe(2);
    expect(imp.fields).toBe(3); // Projects: name + budget; Tickets: id
    expect(imp.behaviors).toBe(2);
  });
});
