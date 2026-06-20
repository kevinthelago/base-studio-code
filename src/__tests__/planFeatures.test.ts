import { describe, it, expect } from "vitest";
import {
  isFeatureKey,
  featureSlug,
  parseFeatureSection,
  featureSectionsToIssues,
  featureDiscoveryComplete,
  incompleteFeatureSections,
  FEATURE_LABEL,
} from "../screens/planner/planFeatures";

describe("isFeatureKey / featureSlug", () => {
  it("recognizes a repo-tier feature key and extracts its slug", () => {
    expect(isFeatureKey("repo__web__feat__login-form")).toBe(true);
    expect(featureSlug("repo__web__feat__login-form")).toBe("login-form");
  });

  it("rejects non-feature sections", () => {
    expect(isFeatureKey("repo__web__api")).toBe(false);     // a dimension, not a feature
    expect(isFeatureKey("repo__web__feat__")).toBe(false);  // empty slug
    expect(isFeatureKey("feat__login")).toBe(false);        // project-tier, not repo-tier
    expect(isFeatureKey("goal")).toBe(false);
    expect(featureSlug("repo__web__api")).toBeNull();
  });
});

describe("parseFeatureSection", () => {
  it("pulls the phase marker, the leading heading title, and acceptance checkboxes out of the body", () => {
    const content = [
      "phase: 2",
      "# Login form",
      "",
      "Build the email/password form against POST /sessions.",
      "",
      "- [ ] validates email format",
      "- [x] shows an inline error on 401",
    ].join("\n");
    const f = parseFeatureSection(content, "login-form");
    expect(f.phase).toBe(2);
    expect(f.title).toBe("Login form");
    expect(f.acceptance).toEqual(["validates email format", "shows an inline error on 401"]);
    expect(f.body).toBe("Build the email/password form against POST /sessions.");
  });

  it("accepts a phase NAME and an HTML-comment marker, and falls back to the humanized slug", () => {
    expect(parseFeatureSection("<!-- phase: Phase 1 — MVP -->\njust prose", "x").phase).toBe("Phase 1 — MVP");
    const f = parseFeatureSection("just an approach, no heading", "password-reset");
    expect(f.title).toBe("Password reset");
    expect(f.phase).toBeUndefined();
    expect(f.body).toBe("just an approach, no heading");
  });

  it("keeps a non-leading heading in the body and only consumes the FIRST heading as title", () => {
    const f = parseFeatureSection("# Title\nintro\n## Approach\nsteps", "t");
    expect(f.title).toBe("Title");
    expect(f.body).toBe("intro\n## Approach\nsteps");
  });
});

describe("featureDiscoveryComplete (#490 rubric)", () => {
  const feat = (body: string, acceptance: string[]) => parseFeatureSection(
    [body.trim() ? `approach: ${body}` : "", ...acceptance.map(a => `- [ ] ${a}`)].join("\n"),
    "slug",
  );

  it("complete when behavior + acceptance present", () => {
    const r = featureDiscoveryComplete(feat("Build the form.", ["shows inline error on 401"]));
    expect(r.complete).toBe(true);
    expect(r.missingBehavior).toBe(false);
    expect(r.missingAcceptance).toBe(false);
  });

  it("incomplete (hard gate) when acceptance is missing", () => {
    const r = featureDiscoveryComplete(feat("Build the form.", []));
    expect(r.complete).toBe(false);
    expect(r.missingAcceptance).toBe(true);
    expect(r.missingBehavior).toBe(false);
  });

  it("incomplete (hard gate) when behavior body is empty", () => {
    const r = featureDiscoveryComplete({ body: "", acceptance: ["returns 200"], title: "T", phase: undefined });
    expect(r.complete).toBe(false);
    expect(r.missingBehavior).toBe(true);
  });

  it("flags missing edge/error cases as a soft warning when body has no keywords", () => {
    const r = featureDiscoveryComplete(feat("Build the happy path only.", ["renders the list"]));
    expect(r.complete).toBe(true);         // not a hard-gate failure
    expect(r.missingEdgeCases).toBe(true); // soft warning surfaced
  });

  it("clears missingEdgeCases when body mentions an error keyword", () => {
    const r = featureDiscoveryComplete(feat("Shows an error state when the fetch fails.", ["shows spinner"]));
    expect(r.missingEdgeCases).toBe(false);
  });
});

describe("featureSectionsToIssues (#490 hard gate)", () => {
  const repos = ["acme/web", "acme/api"];

  it("converts feature sections to synthetic PlanIssues, resolving the repo short name", () => {
    const sections = [
      { k: "repo__web__feat__login", content: "phase: 1\n# Login\napproach here\n- [ ] works" },
      // Sessions endpoint now has acceptance so it passes the gate
      { k: "repo__api__feat__sessions-endpoint", content: "# Sessions endpoint\nadd POST /sessions\n- [ ] returns 201" },
      { k: "repo__web__api", content: "not a feature" },  // ignored
      { k: "goal", content: "ignored" },
    ];
    const issues = featureSectionsToIssues(sections, repos);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      ref: "feat:web:login",
      title: "Login",
      phase: 1,
      repo: "acme/web",
      labels: [FEATURE_LABEL],
      acceptance: ["works"],
    });
    expect(issues[1]).toMatchObject({ ref: "feat:api:sessions-endpoint", title: "Sessions endpoint", repo: "acme/api" });
  });

  it("hard gate: skips features missing acceptance criteria", () => {
    const sections = [
      { k: "repo__web__feat__no-ac", content: "# No AC\napproach only, no checkboxes" },
      { k: "repo__web__feat__has-ac", content: "# Has AC\napproach\n- [ ] works" },
    ];
    const issues = featureSectionsToIssues(sections, repos);
    expect(issues).toHaveLength(1);
    expect(issues[0].ref).toBe("feat:web:has-ac");
  });

  it("hard gate: skips features with no behavior body", () => {
    const sections = [{ k: "repo__web__feat__empty", content: "- [ ] criterion only, no body" }];
    expect(featureSectionsToIssues(sections, repos)).toHaveLength(0);
  });

  it("leaves repo undefined when the short name matches no linked repo (publish files it under the default)", () => {
    const issues = featureSectionsToIssues(
      [{ k: "repo__mobile__feat__x", content: "some approach here\n- [ ] works" }],
      repos,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].repo).toBeUndefined();
    expect(issues[0].ref).toBe("feat:mobile:x");
  });
});

describe("incompleteFeatureSections (#490 UI gate surface)", () => {
  it("returns blocked features with their reasons", () => {
    const sections = [
      { k: "repo__web__feat__missing-both", content: "# Empty feature" },
      { k: "repo__web__feat__missing-ac", content: "# No AC\nsome approach\n" },
      { k: "repo__web__feat__complete", content: "# Done\napproach\n- [ ] ok" },
    ];
    const blocked = incompleteFeatureSections(sections);
    expect(blocked).toHaveLength(2);
    expect(blocked.map(f => f.key)).toContain("repo__web__feat__missing-both");
    expect(blocked.map(f => f.key)).toContain("repo__web__feat__missing-ac");
    const noAc = blocked.find(f => f.key === "repo__web__feat__missing-ac")!;
    expect(noAc.reasons).toContain("no acceptance criteria");
  });

  it("returns empty when all features are complete", () => {
    const sections = [{ k: "repo__web__feat__ok", content: "# Good\napproach\n- [ ] criterion" }];
    expect(incompleteFeatureSections(sections)).toHaveLength(0);
  });
});
