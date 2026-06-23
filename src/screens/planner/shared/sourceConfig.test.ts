import { describe, it, expect } from "vitest";
import {
  CONNECTORS, connector, defaultSourceConfig, newDeclaredSource, sampleScan, redactedHandle,
  isConnected, connectedCount, allSourcesConnected, sourceChecks, coerceSourceConfig, parseSourceConfigTag,
  type DeclaredSource,
} from "./sourceConfig";

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
