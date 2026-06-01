import { describe, it, expect } from "vitest";
import {
  parsePlanFocus, stripPlanFocus, buildSectionConfirmMessage,
  parseStartupScripts, stripStartupScripts, scriptDocRelpath,
  parseAllowCommands, stripAllowCommands,
  parseAgentAssigns, stripAgentAssigns, parseFleetPlan, stripFleetPlan,
} from "../screens/projects/planningSession";

describe("parsePlanFocus", () => {
  it("extracts the section key from a focus tag", () => {
    expect(parsePlanFocus('<plan_focus section="goal" />')).toEqual(["goal"]);
  });

  it("extracts multiple keys in order of appearance", () => {
    const text = 'before <plan_focus section="goal" /> mid <plan_focus section="scope" /> after';
    expect(parsePlanFocus(text)).toEqual(["goal", "scope"]);
  });

  it("tolerates curly smart quotes", () => {
    expect(parsePlanFocus("<plan_focus section=“stack” />")).toEqual(["stack"]);
  });

  it("returns [] when no focus tag is present", () => {
    expect(parsePlanFocus("just some terminal output")).toEqual([]);
  });

  it("ignores other planner tags", () => {
    expect(parsePlanFocus('<plan_update section="goal">x</plan_update>')).toEqual([]);
  });
});

describe("stripPlanFocus", () => {
  it("removes focus tags from the buffer", () => {
    const text = 'a <plan_focus section="goal" /> b <plan_focus section="scope" /> c';
    expect(stripPlanFocus(text)).toBe("a  b  c");
  });

  it("leaves text without focus tags untouched", () => {
    expect(stripPlanFocus("nothing to strip")).toBe("nothing to strip");
  });
});

describe("buildSectionConfirmMessage", () => {
  it("references the section title and instructs to continue", () => {
    const msg = buildSectionConfirmMessage("Goal");
    expect(msg).toContain('"Goal"');
    expect(msg.toLowerCase()).toContain("continue to the next section");
  });

  it("is a single line (no embedded newline that would submit early)", () => {
    expect(buildSectionConfirmMessage("API")).not.toContain("\n");
  });
});

describe("parseStartupScripts", () => {
  it("parses repo, mode, and path from a tag", () => {
    expect(parseStartupScripts('<startup_script repo="acme/web" mode="dev" path="prompts/web-kickoff.md" />')).toEqual([
      { repo: "acme/web", mode: "dev", path: "prompts/web-kickoff.md" },
    ]);
  });

  it("parses several tags and both modes", () => {
    const text =
      '<startup_script repo="acme/web" mode="dev" path="prompts/web-kickoff.md" />\n' +
      '<startup_script repo="acme/web" mode="triage" path="prompts/web-triage.md" />';
    expect(parseStartupScripts(text)).toEqual([
      { repo: "acme/web", mode: "dev", path: "prompts/web-kickoff.md" },
      { repo: "acme/web", mode: "triage", path: "prompts/web-triage.md" },
    ]);
  });

  it("defaults mode to dev when omitted", () => {
    expect(parseStartupScripts('<startup_script repo="o/r" path="prompts/x.md" />')).toEqual([
      { repo: "o/r", mode: "dev", path: "prompts/x.md" },
    ]);
  });

  it("tolerates attribute order and curly quotes", () => {
    expect(parseStartupScripts('<startup_script path=“prompts/x.md” mode=“triage” repo=“o/r” />')).toEqual([
      { repo: "o/r", mode: "triage", path: "prompts/x.md" },
    ]);
  });

  it("skips tags missing repo or path, or with an unknown mode", () => {
    expect(parseStartupScripts('<startup_script mode="dev" path="prompts/x.md" />')).toEqual([]);
    expect(parseStartupScripts('<startup_script repo="o/r" mode="dev" />')).toEqual([]);
    expect(parseStartupScripts('<startup_script repo="o/r" mode="bogus" path="prompts/x.md" />')).toEqual([]);
  });

  it("returns [] when no tag is present", () => {
    expect(parseStartupScripts("plain terminal output")).toEqual([]);
  });
});

describe("stripStartupScripts", () => {
  it("removes startup_script tags from the buffer", () => {
    const text = 'a <startup_script repo="o/r" mode="dev" path="prompts/x.md" /> b';
    expect(stripStartupScripts(text)).toBe("a  b");
  });
});

describe("scriptDocRelpath", () => {
  it("roots a project-relative path under the sanitized project hub", () => {
    expect(scriptDocRelpath("my_project", "prompts/web-kickoff.md"))
      .toBe("projects/my_project/prompts/web-kickoff.md");
  });

  it("leaves an already-rooted projects/ path untouched", () => {
    expect(scriptDocRelpath("k", "projects/k/prompts/x.md")).toBe("projects/k/prompts/x.md");
  });

  it("normalizes backslashes and strips leading slashes", () => {
    expect(scriptDocRelpath("k", "\\prompts\\web.md")).toBe("projects/k/prompts/web.md");
  });
});

describe("parseAllowCommands", () => {
  it("parses a project-scoped command (no repo)", () => {
    expect(parseAllowCommands('<allow_command cmd="cargo" />')).toEqual([
      { cmd: "cargo", repo: null },
    ]);
  });

  it("parses a repo-scoped command", () => {
    expect(parseAllowCommands('<allow_command repo="acme/web" cmd="npm run" />')).toEqual([
      { cmd: "npm run", repo: "acme/web" },
    ]);
  });

  it("parses several tags and tolerates curly quotes", () => {
    const text = '<allow_command cmd="cargo" />\n<allow_command cmd=“pytest” repo=“acme/api” />';
    expect(parseAllowCommands(text)).toEqual([
      { cmd: "cargo", repo: null },
      { cmd: "pytest", repo: "acme/api" },
    ]);
  });

  it("accepts `command=` as an alias for `cmd=`", () => {
    expect(parseAllowCommands('<allow_command command="cargo" />')).toEqual([
      { cmd: "cargo", repo: null },
    ]);
  });

  it("tolerates a missing self-closing slash", () => {
    expect(parseAllowCommands('<allow_command cmd="cargo">')).toEqual([
      { cmd: "cargo", repo: null },
    ]);
  });

  it("skips tags missing cmd", () => {
    expect(parseAllowCommands('<allow_command repo="acme/web" />')).toEqual([]);
  });

  it("returns [] when no tag is present", () => {
    expect(parseAllowCommands("plain output")).toEqual([]);
  });
});

describe("stripAllowCommands", () => {
  it("removes allow_command tags", () => {
    expect(stripAllowCommands('a <allow_command cmd="gh" /> b')).toBe("a  b");
  });
});

describe("parseAgentAssigns", () => {
  it("parses a stream with comma-separated list attributes", () => {
    const tag = '<agent_assign id="auth-ui" name="Auth UI" repo="own/web" owns="src/auth/**,src/components/login/**" issues="#12,#15" depends_on="api" prompt="prompts/auth-ui-kickoff.md" />';
    expect(parseAgentAssigns(tag)).toEqual([{
      id: "auth-ui",
      name: "Auth UI",
      repo: "own/web",
      owns: ["src/auth/**", "src/components/login/**"],
      issues: ["#12", "#15"],
      dependsOn: ["api"],
      prompt: "prompts/auth-ui-kickoff.md",
    }]);
  });

  it("defaults name to id and lists to empty, and skips tags missing id or repo", () => {
    const text = '<agent_assign id="x" repo="o/r" /> <agent_assign name="no id" repo="o/r" /> <agent_assign id="no-repo" />';
    expect(parseAgentAssigns(text)).toEqual([
      { id: "x", name: "x", repo: "o/r", owns: [], issues: [], dependsOn: [], prompt: undefined },
    ]);
  });

  it("tolerates curly quotes", () => {
    const tag = '<agent_assign id=“ui” repo=“o/web” />';
    expect(parseAgentAssigns(tag).map(s => s.id)).toEqual(["ui"]);
  });
});

describe("stripAgentAssigns", () => {
  it("removes agent_assign tags", () => {
    expect(stripAgentAssigns('a <agent_assign id="x" repo="o/r" /> b')).toBe("a  b");
  });
});

describe("parseFleetPlan", () => {
  it("parses the fleet header, coercing recommended and the director flag", () => {
    const tag = '<fleet_plan recommended="4" reasoning="four areas" director="true" director_role="integrator" />';
    expect(parseFleetPlan(tag)).toEqual({
      recommended: 4,
      reasoning: "four areas",
      director: true,
      directorRole: "integrator",
    });
  });

  it("treats a non-true director value as disabled and missing recommended as 0", () => {
    expect(parseFleetPlan('<fleet_plan reasoning="x" director="no" />')).toEqual({
      recommended: 0,
      reasoning: "x",
      director: false,
      directorRole: undefined,
    });
  });

  it("returns the last tag when several are present, or null when none", () => {
    const text = '<fleet_plan recommended="1" /> <fleet_plan recommended="3" />';
    expect(parseFleetPlan(text)?.recommended).toBe(3);
    expect(parseFleetPlan("no tags here")).toBeNull();
  });
});

describe("stripFleetPlan", () => {
  it("removes fleet_plan tags", () => {
    expect(stripFleetPlan('a <fleet_plan recommended="2" /> b')).toBe("a  b");
  });
});

describe("parseAgentAssigns — profile (#289)", () => {
  it("captures a profile attribute, omitting it when absent", () => {
    const tag = '<agent_assign id="be" repo="o/api" owns="src/**" issues="#1" profile="backend-dev" />';
    expect(parseAgentAssigns(tag)[0]).toMatchObject({ id: "be", repo: "o/api", profile: "backend-dev" });
    const noProf = '<agent_assign id="fe" repo="o/web" owns="ui/**" />';
    expect(parseAgentAssigns(noProf)[0].profile).toBeUndefined();
  });
});
