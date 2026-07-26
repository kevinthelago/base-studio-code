import { describe, it, expect } from "vitest";
import { gistUpdateAvailable } from "./blueprintCatalog";

// (The paste-URL `ImportModal` was removed with the gist-import modals in #3802 — its coverage went
// with it; the not-yet-downloaded gist flow now lives in CloudBlueprints.test.tsx. The gist-freshness
// helper is still shared by CloudBlueprints's download path, so its unit tests stay here.)

describe("gistUpdateAvailable (#955)", () => {
  it("is true only when the gist's current updatedAt is strictly newer than the imported one", () => {
    expect(gistUpdateAvailable("2026-06-18T12:00:00Z", "2026-06-01T00:00:00Z")).toBe(true);
    expect(gistUpdateAvailable("2026-06-01T00:00:00Z", "2026-06-18T12:00:00Z")).toBe(false); // older upstream
    expect(gistUpdateAvailable("2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z")).toBe(false); // same ⇒ current
  });
  it("can't tell (⇒ not stale) when either timestamp is missing or unparseable", () => {
    expect(gistUpdateAvailable(undefined, "2026-06-01T00:00:00Z")).toBe(false);
    expect(gistUpdateAvailable("2026-06-18T12:00:00Z", undefined)).toBe(false);
    expect(gistUpdateAvailable("not-a-date", "2026-06-01T00:00:00Z")).toBe(false);
  });
});
