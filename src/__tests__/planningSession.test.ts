import { describe, it, expect } from "vitest";
import {
  parsePlanFocus, stripPlanFocus, buildSectionConfirmMessage,
  parseStartupScripts, stripStartupScripts, scriptDocRelpath,
  parseAllowCommands, stripAllowCommands,
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
