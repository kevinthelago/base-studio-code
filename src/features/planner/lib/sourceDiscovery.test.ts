import { describe, it, expect } from "vitest";
import {
  migrationSources, proposedSourceIds, connectFieldsFor, SOURCE_DIRECTION,
  type DeclaredIntegration,
} from "./sourceDiscovery";

const row = (id: string, direction: string, extra: Partial<DeclaredIntegration> = {}): DeclaredIntegration =>
  ({ id, direction, ...extra });

describe("migrationSources (#4054)", () => {
  // THE point of the direction split. A payment API is not something you migrate off, and offering it
  // as one sends the user down a pointless connect-and-scan path.
  it("keeps only `source` rows — a runtime integration NEVER reaches the Source pane", () => {
    const rows = [row("salesforce", "source"), row("stripe", "runtime"), row("netsuite", "source")];
    expect(migrationSources(rows).map((r) => r.id)).toEqual(["salesforce", "netsuite"]);
  });

  it("preserves declaration order", () => {
    const rows = [row("zeta", "source"), row("alpha", "source")];
    expect(migrationSources(rows).map((r) => r.id)).toEqual(["zeta", "alpha"]);
  });

  // Defensive: the pane must not depend on the caller having passed --direction, and a row with a
  // missing/blank/unknown direction is not evidence of a migration source.
  it("drops rows with a missing, blank or unknown direction", () => {
    const rows = [row("a", ""), { id: "b" } as DeclaredIntegration, row("c", "inbound"), row("d", SOURCE_DIRECTION)];
    expect(migrationSources(rows).map((r) => r.id)).toEqual(["d"]);
  });

  it("drops unusable ids and collapses duplicates to the first", () => {
    const rows = [row("", "source"), row("   ", "source"), row("dup", "source", { name: "First" }), row("dup", "source", { name: "Second" })];
    const out = migrationSources(rows);
    expect(out.map((r) => r.id)).toEqual(["dup"]);
    expect(out[0].name).toBe("First");
  });

  it("trims the id and survives an empty/degenerate input", () => {
    expect(migrationSources([row("  padded  ", "source")])[0].id).toBe("padded");
    expect(migrationSources([])).toEqual([]);
    expect(migrationSources(undefined as unknown as DeclaredIntegration[])).toEqual([]);
  });
});

describe("proposedSourceIds — Discovery wins, the pitch scan is the fallback", () => {
  it("prefers the confirmed Discovery rows over a pitch guess", () => {
    const out = proposedSourceIds([row("salesforce", "source")], ["hubspot", "zendesk"]);
    expect(out).toEqual({ ids: ["salesforce"], origin: "discovery" });
  });

  // The behaviour a project whose Discovery predates #4024 must keep — no regression for anyone who
  // never worked the `integrations` topic.
  it("falls back to the pitch scan when nothing was declared", () => {
    expect(proposedSourceIds([], ["hubspot"])).toEqual({ ids: ["hubspot"], origin: "pitch" });
  });

  // A project that declared ONLY runtime integrations has said nothing about migration sources, so
  // the pitch scan is still the best available signal — `source`-less is not the same as undeclared.
  it("falls back when every declared integration is runtime-only", () => {
    expect(proposedSourceIds([row("stripe", "runtime")], ["hubspot"]).origin).toBe("pitch");
  });

  it("reports `none` when neither has anything, and never proposes a blank id", () => {
    expect(proposedSourceIds([], [])).toEqual({ ids: [], origin: "none" });
    expect(proposedSourceIds([], ["", "ok"])).toEqual({ ids: ["ok"], origin: "pitch" });
  });

  it("returns a fresh array rather than aliasing the caller's pitch list", () => {
    const pitch = ["hubspot"];
    const out = proposedSourceIds([], pitch);
    out.ids.push("mutated");
    expect(pitch).toEqual(["hubspot"]);
  });
});

describe("connectFieldsFor — what Discovery captured reaches the connect form", () => {
  it("carries the base URL and docs so the agent starts from the vendor reference", () => {
    const rows = [row("salesforce", "source", {
      baseUrl: "https://acme.my.salesforce.com", docs: "https://developer.salesforce.com",
    })];
    expect(connectFieldsFor("salesforce", rows)).toEqual({
      baseUrl: "https://acme.my.salesforce.com", docs: "https://developer.salesforce.com",
    });
  });

  // `auth` is a prose SCHEME, not a field value — and keeping it off this path means there is nothing
  // credential-shaped travelling into the connect form's value bag at all.
  it("never carries auth, purpose or name into the connect fields", () => {
    const rows = [row("x", "source", { auth: "OAuth2 client credentials", purpose: "migrate accounts", name: "X" })];
    expect(connectFieldsFor("x", rows)).toEqual({});
  });

  it("omits blank values instead of seeding an empty URL", () => {
    expect(connectFieldsFor("x", [row("x", "source", { baseUrl: "   ", docs: "" })])).toEqual({});
  });

  it("returns nothing for an unknown id, or for one that is a runtime integration", () => {
    const rows = [row("stripe", "runtime", { baseUrl: "https://api.stripe.com" })];
    expect(connectFieldsFor("nope", rows)).toEqual({});
    expect(connectFieldsFor("stripe", rows)).toEqual({});
  });
});
