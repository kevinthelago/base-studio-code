// A local (bsc-agent) session's skills reach it — the regression for `a-local-session-gets-no-skills`.
//
// THE BUG. The only writer of `.claude/skills/<slug>/SKILL.md` is `write_session_skills`, reached from
// the `ensure_session_settings` command — and TerminalView calls that behind
// `launchesClaude = isClaudeProvider && (…)`. A bsc-agent pane is never `isClaudeProvider`, so the
// directory was never created for it, and the runtime's `compose_skills` scanned a path that did not
// exist. Every visible surface then looked exactly like a session with no skills attached, which is
// why it survived: nothing distinguished "none attached" from "never delivered".
//
// The gap was also NARROWER than "no skills", and the distinction matters for what these assert. A
// fleet WORKER did receive the hub's blueprint `skills.md`, inlined into `CLAUDE.local.md` by
// `ensure_worktree`. What no bsc-agent pane received was the PER-PANE RESOLVED set — session
// overrides, skill groups, and the persona's own skills — which is what these pin.
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store";
import { buildAgentEnv, sessionSkillCfgs } from "@/app/console/lib/sessionLaunch";

const SKILLS = [
  { id: "open-pr", name: "Open a clean PR", description: "how this repo opens PRs", prompt: "PR-BODY", tools: [] },
  { id: "review", name: "Review docs", description: "doc review checklist", prompt: "REVIEW-BODY", tools: [] },
];

/** The env a pane would launch with, for a given provider. */
const envFor = (paneId: string, providerId: string) =>
  buildAgentEnv(useAppStore.getState(), paneId, providerId, "") ?? {};

describe("a local session is handed its resolved skills", () => {
  beforeEach(() => {
    useAppStore.setState({ paneSkills: { "p1": SKILLS } } as never);
  });

  it("carries them as $BSC_AGENT_SKILLS, the channel MCP and perms already use", () => {
    // The fix. Before it, a bsc-agent pane's env named its provider, model and permissions and said
    // nothing at all about skills.
    const raw = envFor("p1", "bsc-agent").BSC_AGENT_SKILLS;
    expect(raw, "a bsc-agent pane must be handed its skills").toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.map((s: { id: string }) => s.id)).toEqual(["open-pr", "review"]);
    // The BODY is the part that matters — an id alone tells the model nothing.
    expect(parsed[0].prompt).toBe("PR-BODY");
  });

  it("hands over the SAME array the Claude path writes to .claude/skills", () => {
    // One resolver, two harnesses. While only the Claude side had a resolver, the local side
    // resolved nothing — so this pins that they read from the same place, not merely that both
    // produce something.
    const raw = envFor("p1", "bsc-agent").BSC_AGENT_SKILLS;
    expect(JSON.parse(raw!)).toEqual(sessionSkillCfgs(useAppStore.getState(), "p1"));
  });

  it("does NOT put skills in a Claude pane's env — that harness gets them as files", () => {
    // Claude reads `.claude/skills`, written by ensure_session_settings. Duplicating them into the
    // environment would be a second copy of the same thing, and the copy is what drifts.
    expect(envFor("p1", "claude").BSC_AGENT_SKILLS).toBeUndefined();
  });

  it("says nothing when the pane genuinely has no skills", () => {
    // An absent var and an empty array are different claims; the runtime treats the var as
    // authoritative when present, so an empty one would assert "this pane has none" and suppress
    // the filesystem fallback that serves a bare run.
    useAppStore.setState({ paneSkills: { "p1": [] } } as never);
    expect("BSC_AGENT_SKILLS" in envFor("p1", "bsc-agent")).toBe(false);
  });
});

describe("sessionSkillCfgs — the one resolver", () => {
  it("prefers the pane's pre-resolved snapshot (fleet/triage) over the global set", () => {
    useAppStore.setState({
      paneSkills: { "p1": SKILLS },
      skills: [{ id: "global", name: "Global", description: "", prompt: "GLOBAL-BODY", tools: [] }],
    } as never);
    const ids = sessionSkillCfgs(useAppStore.getState(), "p1").map((s) => s.id);
    expect(ids).toEqual(["open-pr", "review"]);
    expect(ids).not.toContain("global");
  });

  it("falls back to the global set for an ad-hoc console with no snapshot", () => {
    useAppStore.setState({
      paneSkills: {},
      // `enabled` + an empty `projects` is what makes a library skill globally in scope
      // (sessionSkillState): a disabled skill is off everywhere, and a project-scoped one is off for
      // a console that names no project.
      skills: [{ id: "global", name: "Global", description: "", prompt: "GLOBAL-BODY", tools: [],
                 enabled: true, projects: [] }],
      sessionSkillOverrides: {},
      sessionSkillGroups: {},
      skillGroups: [],
    } as never);
    // A manual pane is exactly the case that has no fleet snapshot, and it is also the case a user
    // is most likely to open by hand against a local model.
    expect(sessionSkillCfgs(useAppStore.getState(), "man:t1p1").map((s) => s.id)).toEqual(["global"]);
  });
});
