import { describe, it, expect } from "vitest";
import {
  DESTINATIONS, destinationMeta, defaultIntegrationConfig,
  destinationChecks, destinationDefined, syncChecks, syncDefined,
  type IntegrationConfig,
} from "./integrationConfig";

const cfg = (over: Partial<IntegrationConfig["destination"]> = {}, sync: Partial<IntegrationConfig["sync"]> = {}): IntegrationConfig => ({
  destination: { ...defaultIntegrationConfig().destination, ...over },
  sync: { ...defaultIntegrationConfig().sync, ...sync },
});

describe("integrationConfig — destination", () => {
  it("catalog + fallback lookup", () => {
    expect(DESTINATIONS.map((d) => d.id)).toContain("warehouse");
    expect(destinationMeta("nope").name).toBe("nope"); // unknown id ⇒ shown as-is
    expect(destinationMeta("").name).toBe("—");         // empty ⇒ placeholder
  });

  it("destinationDefined needs type + target + write mode", () => {
    expect(destinationDefined(defaultIntegrationConfig())).toBe(false);
    expect(destinationDefined(cfg({ type: "warehouse" }))).toBe(false);          // no target/write
    expect(destinationDefined(cfg({ type: "warehouse", target: "bq://x" }))).toBe(false); // no write
    expect(destinationDefined(cfg({ type: "warehouse", target: "bq://x", writeMode: "upsert" }))).toBe(true);
    expect(destinationDefined(undefined)).toBe(false);
  });

  it("destinationChecks reflect each field", () => {
    const byId = Object.fromEntries(destinationChecks(cfg({ type: "database", target: " " }).destination).map((c) => [c.id, c.ok]));
    expect(byId.type).toBe(true);
    expect(byId.target).toBe(false); // whitespace-only ⇒ not set
  });
});

describe("integrationConfig — sync", () => {
  it("full sync needs mode + schedule (no watermark required)", () => {
    expect(syncDefined(cfg({}, { mode: "full" }))).toBe(false);                          // no schedule
    expect(syncDefined(cfg({}, { mode: "full", schedule: "0 2 * * *" }))).toBe(true);
  });

  it("incremental sync additionally requires a watermark", () => {
    expect(syncDefined(cfg({}, { mode: "incremental", schedule: "@hourly" }))).toBe(false);
    expect(syncDefined(cfg({}, { mode: "incremental", schedule: "@hourly", watermark: "updated_at" }))).toBe(true);
  });

  it("syncChecks: watermark is n/a for full, needed for incremental", () => {
    const full = Object.fromEntries(syncChecks(cfg({}, { mode: "full", schedule: "x" }).sync).map((c) => [c.id, c.ok]));
    expect(full.watermark).toBe(true);
    const inc = Object.fromEntries(syncChecks(cfg({}, { mode: "incremental", schedule: "x" }).sync).map((c) => [c.id, c.ok]));
    expect(inc.watermark).toBe(false);
  });
});
