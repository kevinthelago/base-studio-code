// The role gate's behaviour, captured from the LIVE TypeScript so Rust can be proved to match it.
//
// ## Why a fixture rather than a hand-written table
//
// `launch-rules.ts` derives the security policy a session launches under — which commands are denied,
// which tools, which paths. Rust ENFORCES it (`deny_matches`, bsc-util/src/deny.rs) and WRITES it
// (`ensure_session_settings` takes the computed lists) but never COMPUTES it, so the policy is decided
// in the renderer. `epic-frontend-logic-over-backend-resources-belongs-in-rust` moves that derivation.
//
// A port of security policy that is subtly different is worse than no port. So this generates the
// answer from the implementation that is live TODAY, and a Rust test asserts its own derivation
// matches case for case. Hand-writing the expectations would only prove Rust agrees with whoever
// typed the table.
//
// Same pattern as `tunnelProtocol.fixtures.json` / `plannerCore.fixtures.json`: one byte-exact
// artifact read by BOTH sides. Regenerate deliberately:
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/session/roleGate.fixtures.gen.test.ts
//
// A regeneration that changes the file is a CHANGE OF POLICY. Read the diff before committing it.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROLE_DEFAULTS, roleCapability, type SessionRole } from "@/shared/lib/session/roleModel";
import {
  roleDeniedCommands,
  roleDeniedTools,
  roleWriteRules,
  sessionScopes,
} from "@/shared/lib/session/launchRules";

const FIXTURE = join(process.cwd(), "src/shared/lib/session/roleGate.fixtures.json");

/** A surface catalog to complement against. Two shapes, because the EMPTY one fails open by design
 *  (see `roleDeniedCommands`) and that asymmetry is exactly the kind of thing a port drops. */
const SURFACES: Record<string, string[]> = {
  none: [],
  catalog: ["ui", "plan", "graph", "persona", "teams", "request", "fleet", "logs"],
};

/** Write globs are filled PER ASSIGNMENT, so a worker with an owned glob is a distinct case from one
 *  without: the carve-out logic branches on it. */
const GLOBS: Record<string, string[]> = {
  none: [],
  owned: ["src/**/*.ts", "contracts/**/*.json"],
};

function build() {
  const roles = Object.keys(ROLE_DEFAULTS).sort() as SessionRole[];
  const cases = [];
  for (const role of roles) {
    for (const [surfaceKey, surfaces] of Object.entries(SURFACES)) {
      for (const [globKey, writeGlobs] of Object.entries(GLOBS)) {
        const cap = roleCapability(role, writeGlobs.length ? { writeGlobs } : {});
        cases.push({
          role,
          surfaces: surfaceKey,
          globs: globKey,
          // EVERY field the derivation reads, so Rust can reproduce it from the fixture alone.
          // `allow` and `surfaces` were missing on the first pass and they are not decoration:
          // `isRestrictedRole`, `capabilitySurfaces` and `mayFileToolingRequest` all branch on them,
          // so a fixture without them cannot express the cases that matter most.
          capability: {
            role: cap.role,
            github: cap.github, git: cap.git, code: cap.code, net: cap.net, ui: cap.ui,
            // `graph` joins the projection the moment `roleDeniedCommands` starts reading it. This is
            // the exact trap the comment above records: a derivation that reads a field the fixture
            // does not carry cannot be reproduced from the fixture, and Rust's parity test fails
            // pointing at the DERIVATION when the fault is in what was captured
            // (`the-algorithms-graph-has-no-write-gate`).
            graph: cap.graph,
            writeGlobs: cap.writeGlobs ?? [],
            allow: [...(cap.allow ?? [])],
            surfaces: cap.surfaces ? [...cap.surfaces] : null,
          },
          deniedCommands: roleDeniedCommands(cap, surfaces),
          deniedTools: roleDeniedTools(cap),
          writeRules: roleWriteRules(cap),
          scopes: sessionScopes(cap),
        });
      }
    }
  }
  return { note: "GENERATED from the live TypeScript — see roleGate.fixtures.gen.test.ts", roles, surfaces: SURFACES, cases };
}

describe("the role gate's behaviour is captured for Rust to match", () => {
  it("matches the committed fixture (UPDATE_FIXTURES=1 to regenerate)", () => {
    const built = build();
    const text = JSON.stringify(built, null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") {
      writeFileSync(FIXTURE, text);
    }
    expect(existsSync(FIXTURE), `${FIXTURE} is missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });

  it("covers every role the table defines, so a new role cannot slip past the port", () => {
    const built = build();
    expect(built.roles.length).toBeGreaterThanOrEqual(9);
    expect(new Set(built.cases.map((c) => c.role)).size).toBe(built.roles.length);
  });
});
