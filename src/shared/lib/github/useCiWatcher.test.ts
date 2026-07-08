import { describe, it, expect } from "vitest";
import { ciGroupKey, ciDirectorPaneFor } from "./useCiWatcher";

// #2604 — the CI watcher's green-PR merge nudge was addressed to a pane id built with the obsolete
// positional `t{n}p{m}` math, which never resolved a stable-identity director, so the director merged
// nothing. These guard the identity-aware derivation (and the legacy fallback).
describe("useCiWatcher pane-id derivation (#2604 — the director-merge nudge)", () => {
  it("resolves the director from a stable-identity worker id — the exact break was a 'p' in the project key", () => {
    // "my[p]roject": the old `slice(0, indexOf('p'))+'p0'` produced garbage "myp0" — no such pane.
    expect(ciDirectorPaneFor("myproject:auth-ui")).toBe("myproject:director");
    expect(ciDirectorPaneFor("stock:api")).toBe("stock:director");
    // the director pane itself resolves to itself (stable, idempotent)
    expect(ciDirectorPaneFor("myproject:director")).toBe("myproject:director");
  });

  it("groups identity workers by their project key (both streams of a project share a group)", () => {
    expect(ciGroupKey("myproject:auth-ui")).toBe("myproject");
    expect(ciGroupKey("myproject:director")).toBe("myproject");
    expect(ciGroupKey("stock:api")).toBe(ciGroupKey("stock:web"));
  });

  it("falls back to the legacy positional scheme for old fleets (t{n}p{m} → p0)", () => {
    expect(ciDirectorPaneFor("t0p2")).toBe("t0p0");
    expect(ciGroupKey("t0p2")).toBe("t0p");
  });
});
