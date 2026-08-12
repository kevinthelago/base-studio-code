// GENERATOR + parity guard for `storePayloads.fixtures.json` (#3761 / D3 of Mobile-Studio-Code#246).
//
// `store_state` is `{ domain, rev, json }` where `json` is an OPAQUE serialized string, so every
// per-domain payload shape crosses the wire completely unguarded — the class of bug behind the glance
// `status`→`health`/`activity` split (mobile read a deleted field for ~12 days) and the security
// invented-shape (every section blank against a live feed). This file runs the REAL builders over the
// model-checked `PROJECTION_INPUTS` and pins the canonical output as a byte-comparable fixture that
// mobile-studio-code decodes with its own selectors — so a silent shape change fails a test.
//
// Regenerate:  UPDATE_STORE_FIXTURES=1 npx vitest run storePayloads.fixtures   (or `npm run fixtures:store`)
// The write is env-gated so CI (which never sets it) can never self-heal a real drift.

import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildGlancePayload, buildOrgPayload, buildBlueprintsPayload, buildSkillsPayload,
  buildComponentsPayload, buildThemesPayload, buildAutomationsPayload, buildMcpPayload,
  buildAlertsPayload, buildSecurityPayload,
} from "./storeProjections";
// #3760: the `plan` domain's builder lives in the planner feature (it's planner-published), reached
// via the barrel so the harness covers plan like every other domain.
import { buildPlanBoardPayload } from "@/features/planner";
// #3922: guards the org fixture's archetype ids against the real closed vocabulary.
import { archetypeById } from "@/features/teams";
import { PROJECTION_INPUTS } from "./storeProjections.fixtures";
import { STORE_DOMAINS } from "./tunnelClient";

// Resolved from cwd (repo/worktree root when vitest runs), matching the primitives.gen idiom.
const FILE = join(process.cwd(), "src/features/tunnel/lib/storePayloads.fixtures.json");

// Every registered store domain now has a builder + fixture (#3760 brought `plan` in — its builder
// lives in the planner feature, `buildPlanBoardPayload`). The exemption list is kept (empty) so a
// future planner-only or transient domain can be documented here rather than silently dropped.
const UNPROJECTED_DOMAINS = [] as const;

// The canonical payloads — the REAL builders over the canonical inputs, one per projected domain.
const domains = {
  glance: buildGlancePayload(PROJECTION_INPUTS.glance),
  org: buildOrgPayload(PROJECTION_INPUTS.org),
  blueprints: buildBlueprintsPayload(PROJECTION_INPUTS.blueprints),
  skills: buildSkillsPayload(PROJECTION_INPUTS.skills),
  components: buildComponentsPayload(PROJECTION_INPUTS.components),
  themes: buildThemesPayload(PROJECTION_INPUTS.themes),
  automations: buildAutomationsPayload(PROJECTION_INPUTS.automations),
  mcp: buildMcpPayload(PROJECTION_INPUTS.mcp),
  alerts: buildAlertsPayload(PROJECTION_INPUTS.alerts),
  security: buildSecurityPayload(PROJECTION_INPUTS.security),
  plan: buildPlanBoardPayload(PROJECTION_INPUTS.plan),
};

// Variants pin optionality + nullability the way `auth_ok_pre_grant` does for frames: each toggles ONE
// optional/nullable input away from its default so mobile's selectors are exercised against the
// null/non-default branch, not just the populated-with-the-default-looking-value one.
const variants = {
  glance_l0: buildGlancePayload({ ...PROJECTION_INPUTS.glance, drill: null }),
  skills_no_lessons: buildSkillsPayload({ ...PROJECTION_INPUTS.skills, lessons: null }),
  blueprints_no_team: buildBlueprintsPayload({
    blueprints: [PROJECTION_INPUTS.blueprints.blueprints[1]], // the team-less `migrate` card
    activeBlueprintId: "migrate",
  }),
  // #3922: `KitTheme.base` is optional and defaults to "dark", so an absent value and an explicit
  // "dark" are indistinguishable on the wire — only a "light" value proves a consumer reads the
  // field instead of silently falling back (the exact bug this variant was filed over).
  themes_light: buildThemesPayload({
    themes: [{ ...PROJECTION_INPUTS.themes.themes[0], base: "light" }],
    active: "soft",
  }),
};

const generated = {
  $comment:
    "Canonical store_state PAYLOAD fixtures (#3761 / Mobile-Studio-Code#246), GENERATED from the real " +
    "build*Payload functions over PROJECTION_INPUTS (storeProjections.fixtures.ts) — never hand-authored. " +
    "Shared BYTE-IDENTICALLY with mobile-studio-code, whose selectors decode `domains.<d>` / `variants.<v>` " +
    "and assert a non-degenerate view. INVARIANT: no field here equals a mobile selector's fallback (no " +
    "`idle` health, real ISO-8601 audit timestamps, non-default enums), so the smoke layer can tell " +
    "'read correctly' from 'fell back' — a pure field DELETION still fails. Small on purpose (2-3 rows / " +
    "collection); cap behaviour (SECURITY_AUDIT_CAP / AUTOMATION_RUNS_CAP) is asserted in " +
    "storeProjections.test.ts, NOT by inflating this file. Regenerate: `npm run fixtures:store`. " +
    "All 11 registered domains are covered — `plan` (planner-published, built by buildPlanBoardPayload) " +
    "was brought in by #3760.",
  domains,
  variants,
};

const serialised = JSON.stringify(generated, null, 2) + "\n";

describe("storePayloads.fixtures.json — canonical per-domain payload parity (#3761)", () => {
  it("regenerates the committed fixture when UPDATE_STORE_FIXTURES=1 (env-gated so CI can't self-heal)", () => {
    if (process.env.UPDATE_STORE_FIXTURES) writeFileSync(FILE, serialised);
    expect(existsSync(FILE), "storePayloads.fixtures.json missing — run `npm run fixtures:store`").toBe(true);
  });

  it("matches the builder output round-tripped through JSON (drops undefined-valued keys, as the wire does)", () => {
    const onDisk = JSON.parse(readFileSync(FILE, "utf8").replace(/\r\n/g, "\n"));
    // JSON.parse(JSON.stringify(...)) drops `undefined`-valued keys — exactly what serialization sends
    // over the tunnel, so the fixture is compared against what mobile ACTUALLY receives.
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(generated)));
  });

  it("covers every registered store domain (minus the tracked UNPROJECTED exemptions)", () => {
    const covered = new Set(Object.keys(domains));
    const missing = STORE_DOMAINS.filter((d) => !covered.has(d) && !UNPROJECTED_DOMAINS.includes(d as never));
    expect(missing, `store domains with no payload fixture: ${missing.join(", ")}`).toEqual([]);
  });

  it("pins the nullable fields via variants (the null branch mobile's selectors must handle)", () => {
    expect(variants.glance_l0.drill).toBeNull();
    expect(variants.glance_l0.drillFleet).toBeNull();
    expect(variants.skills_no_lessons.lessons).toBeNull();
    expect(variants.blueprints_no_team.activeTeam).toBeNull();
  });

  it("pins the theme surface via a light variant (#3922 — the field a real consumer bug was filed over)", () => {
    expect(variants.themes_light.themes[0].base).toBe("light");
  });

  it("guards the org archetype vocabulary (#3922 — a fixture id that names no real archetype renders as zero edges everywhere)", () => {
    for (const org of PROJECTION_INPUTS.org.orgs) {
      for (const rel of org.relationships) {
        expect(
          archetypeById(rel.archetype),
          `org "${org.id}" relationship "${rel.id}" uses unknown archetype "${rel.archetype}"`,
        ).toBeDefined();
      }
    }
  });
});
