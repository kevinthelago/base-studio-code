import { describe, it, expect } from "vitest";
import {
  isFeatureKey,
  featureSlug,
  parseFeatureSection,
  featureSectionsToIssues,
  FEATURE_LABEL,
} from "../screens/projects/planFeatures";

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

describe("featureSectionsToIssues", () => {
  const repos = ["acme/web", "acme/api"];

  it("converts feature sections to synthetic PlanIssues, resolving the repo short name", () => {
    const sections = [
      { k: "repo__web__feat__login", content: "phase: 1\n# Login\napproach\n- [ ] works" },
      { k: "repo__api__feat__sessions-endpoint", content: "# Sessions endpoint\nadd POST /sessions" },
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

  it("leaves repo undefined when the short name matches no linked repo (publish files it under the default)", () => {
    const issues = featureSectionsToIssues([{ k: "repo__mobile__feat__x", content: "y" }], repos);
    expect(issues[0].repo).toBeUndefined();
    expect(issues[0].ref).toBe("feat:mobile:x");
  });
});
