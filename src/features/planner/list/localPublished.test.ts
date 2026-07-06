// #2445 — the local published inventory: published hubs render offline; GitHub records overlay.
import { describe, it, expect } from "vitest";
import { buildLocalPublished } from "./localPublished";
import type { LocalProjectLite } from "./drafts";

const hub = (key: string, title: string, published = true, updatedAt = 1): LocalProjectLite =>
  ({ key, title, hasPlan: true, updatedAt, published });

describe("buildLocalPublished (#2445)", () => {
  it("lists published hubs when NO GitHub data is present (logged out / fetch not landed)", () => {
    const rows = buildLocalPublished([hub("acme-crm", "Acme CRM"), hub("draft-x", "Draft X", false)], []);
    expect(rows).toEqual([{ key: "acme-crm", title: "Acme CRM", updatedAt: 1 }]);
  });

  it("a fetched board OVERLAYS its hub — matched by the name-derived slug key (#2409)", () => {
    const rows = buildLocalPublished([hub("acme-crm", "custom display name")], [{ title: "Acme CRM" }]);
    expect(rows).toEqual([]); // projectSlug("Acme CRM") === "acme-crm" ⇒ the board row renders instead
  });

  it("a fetched board OVERLAYS a legacy title-keyed hub (sanitizeProjectKey form)", () => {
    // Legacy grandfathered hubs are keyed by the case-preserving sanitize: "Acme CRM" → "Acme_CRM".
    const rows = buildLocalPublished([hub("Acme_CRM", "whatever")], [{ title: "Acme CRM" }]);
    expect(rows).toEqual([]);
  });

  it("a fetched board OVERLAYS a hub whose TITLE matches case-insensitively (mirrors the reconcile)", () => {
    const rows = buildLocalPublished([hub("p-abc123", "acme crm")], [{ title: "Acme CRM" }]);
    expect(rows).toEqual([]);
  });

  it("an UNMATCHED published hub survives the overlay (board deleted / hidden)", () => {
    const rows = buildLocalPublished([hub("orphan-app", "Orphan App")], [{ title: "Some Other Project" }]);
    expect(rows).toEqual([{ key: "orphan-app", title: "Orphan App", updatedAt: 1 }]);
  });

  it("tolerates a non-array local list (#874)", () => {
    expect(buildLocalPublished(null as never, [])).toEqual([]);
  });
});
