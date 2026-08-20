// The panel PRESENTS; it does not edit (#2382). The two tests this file replaced drove the
// two-step delete confirms added as interim manual overrides (#2383/#2384) — those controls are gone,
// so the assertions that would have caught a regression are inverted: no control in this panel may
// write team, position, persona or relationship data.
//
// The guard is written against the RENDERED ROLES rather than against component names, because that is
// what a user can actually reach: a `<button>`, a `<textbox>`, a `<combobox>` or a `<checkbox>` inside
// the inspector IS an editing affordance no matter which primitive drew it. A future change that
// reintroduces one — by any route — fails here.
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { TeamsInspector } from "@/features/teams/TeamsInspector";
import { RELATIONSHIP_ARCHETYPES, type Team } from "./lib/team";
import type { Persona } from "@/features/personas";
import type { SkillDef } from "@/features/skills";

const worker: Persona = {
  id: "p-worker",
  name: "Worker",
  blurb: "Executes one issue in its own worktree.",
  role: "worker",
  startPrompt: "You own exactly one issue.",
  skills: ["skill-testing"],
  responsibilities: ["Land the issue", "Write its tests"],
  model: "claude-sonnet-4-6",
};

/** A read-only persona with the tightest floor in the table — `designer` is `none` on git/github/code
 *  and `write` on ui, so it proves the tier chips render a real row rather than one hardcoded shape. */
const designer: Persona = {
  id: "p-designer", name: "Designer", blurb: "Owns the UI kit.",
  role: "designer", startPrompt: "", skills: [],
};

const org: Team = {
  id: "o1",
  name: "Test org",
  positions: [
    { nodeId: "n1", kind: "agent", personaId: "p-worker" },
    { nodeId: "n2", kind: "resource", label: "Ledger" },
    { nodeId: "n3", kind: "agent", personaId: "p-designer" },
  ],
  relationships: [{ id: "r1", archetype: RELATIONSHIP_ARCHETYPES[0].id, from: "n1", to: "n2" }],
};

const baseProps = { org, orgs: [org], personas: [worker, designer], skills: [],
                    onSelectNode: () => {}, onSelectSkill: () => {}, onSelectPersona: () => {} };

/**
 * Every control a user could EDIT something with.
 *
 * This deliberately does NOT count every `<button>` any more. It used to, and that conflated "the
 * panel cannot edit" with "the panel cannot navigate" — the moment a skill chip became a real,
 * keyboard-reachable link to its persona, a blanket button ban would have argued for hiding it from
 * assistive tech to keep a test green. Navigation buttons opt out via `data-nav-chip`; anything else
 * that can press or type still counts, and the accompanying test asserts the panel takes no mutating
 * prop at all, which is the structural half of the same guarantee.
 */
const editingControls = (root: HTMLElement) => [
  ...within(root).queryAllByRole("button").filter((b) => !b.hasAttribute("data-nav-chip")),
  ...within(root).queryAllByRole("textbox"),
  ...within(root).queryAllByRole("combobox"),
  ...within(root).queryAllByRole("checkbox"),
  ...within(root).queryAllByRole("spinbutton"),
  ...root.querySelectorAll("input, textarea, select"),
];

describe("TeamsInspector — presents, never edits (#2382)", () => {
  it("renders NO editing control for a selected position", () => {
    const { container } = render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n1" }} />);
    expect(editingControls(container)).toHaveLength(0);
  });

  it("renders NO editing control for a selected relationship", () => {
    const { container } = render(<TeamsInspector {...baseProps} sel={{ type: "edge", id: "r1" }} />);
    expect(editingControls(container)).toHaveLength(0);
  });

  it("renders NO editing control for a resource position (the label field is gone)", () => {
    const { container } = render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n2" }} />);
    expect(editingControls(container)).toHaveLength(0);
    expect(screen.getByText("Ledger")).toBeTruthy();               // still SHOWN, in the header
    expect(screen.getAllByText("Resource")).toHaveLength(1);       // its kind, stated once
    expect(screen.getByText(/A shared resource/)).toBeTruthy();    // and what that kind means
  });

  it("names the surface that does the writing, so a removed control is not just missing", () => {
    render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n1" }} />);
    expect(screen.getByText("bsc teams")).toBeTruthy();
    expect(screen.getByText("bsc persona")).toBeTruthy();
  });
});

describe("TeamsInspector — the persona is presented in full", () => {
  it("shows every field the removed editor let you type: charter, model, skills, prompt", () => {
    render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n1" }} />);
    expect(screen.getByText("Worker")).toBeTruthy();     // once — the header names the position
    expect(screen.getByText("Executes one issue in its own worktree.")).toBeTruthy();
    expect(screen.getByText("Land the issue")).toBeTruthy();
    expect(screen.getByText("claude-sonnet-4-6")).toBeTruthy();
    expect(screen.getByText("skill-testing")).toBeTruthy();
    expect(screen.getByText("You own exactly one issue.")).toBeTruthy();
  });

  it("says so when a persona has no start prompt, naming the role it falls back to", () => {
    render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n3" }} />);
    expect(screen.getByText(/falls back to the designer role/)).toBeTruthy();
  });

  it("an agent position with no persona bound renders the empty identity, not a crash", () => {
    const bare: Team = { ...org, positions: [{ nodeId: "n9", kind: "agent" }], relationships: [] };
    render(<TeamsInspector {...baseProps} org={bare} orgs={[bare]} sel={{ type: "node", id: "n9" }} />);
    expect(screen.getByText(/No persona bound/)).toBeTruthy();
  });
});

describe("TeamsInspector — the role capability floor (moved off the Settings card)", () => {
  it("renders all five access tiers for the persona's role, read from the enforcement core", () => {
    render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n1" }} />);
    // `worker`: git·write, github·read, code·write, net·read, ui·read (role-capabilities.json).
    for (const chip of ["git · write", "github · read", "code · write", "net · read", "ui · read"]) {
      expect(screen.getByText(chip), `missing tier chip: ${chip}`).toBeTruthy();
    }
  });

  it("follows the role, not a hardcoded row — the designer floor differs on every axis that should", () => {
    render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n3" }} />);
    for (const chip of ["git · none", "github · none", "code · none", "net · none", "ui · write"]) {
      expect(screen.getByText(chip), `missing tier chip: ${chip}`).toBeTruthy();
    }
  });

  it("shows the write-scope globs when the role has them, and an em-dash when it has none", () => {
    // designer carries `scratch/**`; worker's writeGlobs are empty (its lane is scoped per-assignment,
    // not by the role table). Both branches, so neither can rot into always-rendering one shape.
    const { unmount } = render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n3" }} />);
    expect(screen.getByText("write-scope")).toBeTruthy();
    expect(screen.getByText("scratch/**")).toBeTruthy();
    unmount();
    render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n1" }} />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("carries no capability block for a resource position — it runs nothing", () => {
    render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n2" }} />);
    expect(screen.queryByText("Capability")).toBeNull();
  });
});

describe("TeamsInspector — the identity block never echoes the header", () => {
  it("omits the persona name when the header already IS that name", () => {
    render(<TeamsInspector {...baseProps} sel={{ type: "node", id: "n1" }} />);
    expect(screen.getAllByText("Worker")).toHaveLength(1);
  });

  it("shows the persona name when the position carries a local label override", () => {
    const labelled: Team = { ...org, positions: [{ nodeId: "n1", kind: "agent", personaId: "p-worker", label: "Engineer A" }] };
    render(<TeamsInspector {...baseProps} org={labelled} orgs={[labelled]} sel={{ type: "node", id: "n1" }} />);
    expect(screen.getByText("Engineer A")).toBeTruthy();  // the position
    expect(screen.getByText("Worker")).toBeTruthy();      // the shared identity behind it
  });
});

// ── the Capability block reads the PERSONA's floor, not its role's row ────────────────────────────
//
// It used to look the capability up by role. That was right while the role table was the source, and
// became wrong the moment a persona could carry a floor narrower than its role's: the panel would have
// said a session may write code while the session it describes cannot.
describe("TeamsInspector — the Capability block renders the persona's own floor", () => {
  /** A persona whose floor is deliberately NARROWER than the `worker` role row it names. */
  const narrowed: Persona = {
    id: "p-narrow", name: "Narrow worker", blurb: "Tightened worker.",
    role: "worker", startPrompt: "", skills: [],
    derivesFrom: "p-base",
    floor: { github: "none", git: "none", code: "none", net: "none", ui: "none" },
  };
  /** The ancestor it narrowed FROM — the packaged worker capability. */
  const base: Persona = {
    id: "p-base", name: "Worker", blurb: "", role: "worker", startPrompt: "", skills: [],
    floor: { github: "read", git: "write", code: "write", net: "read", ui: "read" },
  };

  const team: Team = {
    id: "o2", name: "Floors", relationships: [],
    positions: [{ nodeId: "n1", kind: "agent", personaId: "p-narrow" },
                { nodeId: "n2", kind: "agent", personaId: "p-base" }],
  };
  const props = { org: team, orgs: [team], personas: [narrowed, base], skills: [],
                onSelectNode: () => {}, onSelectSkill: () => {}, onSelectPersona: () => {} };

  it("shows the FLOOR's tiers, not the tiers its role would imply", () => {
    render(<TeamsInspector {...props} sel={{ type: "node", id: "n1" }} />);
    // `worker` is git:write / code:write. This persona's floor says none, and the floor is what launches.
    expect(screen.getByText("git · none")).toBeTruthy();
    expect(screen.getByText("code · none")).toBeTruthy();
    expect(screen.queryByText("git · write")).toBeNull();
  });

  it("names what it narrowed FROM, and on which axes", () => {
    // The single most interesting fact about a derived persona is that someone tightened it. Resulting
    // tiers alone make it indistinguishable from one simply authored narrow.
    render(<TeamsInspector {...props} sel={{ type: "node", id: "n1" }} />);
    expect(screen.getByText("derives from · Worker")).toBeTruthy();
    expect(screen.getByText("narrowed")).toBeTruthy();
    expect(screen.getByText("git · write → none")).toBeTruthy();
    expect(screen.getByText("code · write → none")).toBeTruthy();
    // `github` went read→none, so it is narrowed too; `net`/`ui` likewise. All five moved here.
    expect(screen.getByText("github · read → none")).toBeTruthy();
  });

  it("shows no narrowing for a persona that derives from nothing", () => {
    render(<TeamsInspector {...props} sel={{ type: "node", id: "n2" }} />);
    expect(screen.queryByText("narrowed")).toBeNull();
    expect(screen.getByText("role · worker")).toBeTruthy();   // falls back to naming the role
  });

  it("falls back to the role's row when a persona carries no floor", () => {
    // `floor` is optional, and the panel must show what would ACTUALLY launch — which is the same
    // fallback `paneCapability` performs.
    const noFloor: Persona = { ...base, id: "p-nofloor", floor: undefined };
    const t: Team = { ...team, positions: [{ nodeId: "n1", kind: "agent", personaId: "p-nofloor" }] };
    render(<TeamsInspector {...props} org={t} orgs={[t]} personas={[noFloor]} sel={{ type: "node", id: "n1" }} />);
    expect(screen.getByText("git · write")).toBeTruthy();     // the worker role row
  });

  it("renders the confined command surface when the floor declares one", () => {
    const confined: Persona = {
      ...base, id: "p-confined",
      floor: { github: "none", git: "none", code: "none", net: "none", ui: "write", allow: ["bsc ui"] },
    };
    const t: Team = { ...team, positions: [{ nodeId: "n1", kind: "agent", personaId: "p-confined" }] };
    render(<TeamsInspector {...props} org={t} orgs={[t]} personas={[confined]} sel={{ type: "node", id: "n1" }} />);
    expect(screen.getByText("confined to 1 command")).toBeTruthy();
    expect(screen.getByText("bsc ui")).toBeTruthy();
  });

  it("gains no editing control — the read-only contract survives the rewrite", () => {
    const { container } = render(<TeamsInspector {...props} sel={{ type: "node", id: "n1" }} />);
    expect(editingControls(container)).toHaveLength(0);
  });
});

// ── skills live beside the agents that carry them ────────────────────────────────────────────────
//
// A skill is injectable agent CONTEXT. Its library card could always say what it IS; it could never
// say which agents it REACHES — and that blast radius is the reason it belongs here rather than on a
// rail destination of its own.
describe("TeamsInspector — the skill view (skills move to Teams)", () => {
  const review: SkillDef = {
    id: "sk-review", name: "Code review checklist", kind: "procedure", source: "user",
    desc: "What to look for before approving.", prompt: "1. Read the diff twice.",
    tools: ["Read", "Grep"], profiles: [], projects: [], enabled: true, pinned: true,
  } as unknown as SkillDef;
  const orphan: SkillDef = { ...review, id: "sk-orphan", name: "Orphan skill", pinned: false } as SkillDef;

  const carrier: Persona = {
    id: "p-carrier", name: "Reviewer", blurb: "", role: "reviewer", startPrompt: "",
    skills: ["sk-review", "sk-vanished"],
  };
  const team: Team = {
    id: "o3", name: "Skills", relationships: [],
    positions: [{ nodeId: "n1", kind: "agent", personaId: "p-carrier" }],
  };
  const props = {
    org: team, orgs: [team], personas: [carrier], skills: [review, orphan],
    onSelectNode: () => {}, onSelectSkill: () => {}, onSelectPersona: () => {},
  };

  it("shows the skill read-only, with its description and bundled tools", () => {
    render(<TeamsInspector {...props} sel={{ type: "skill", id: "sk-review" }} />);
    expect(screen.getByText("Code review checklist")).toBeTruthy();
    expect(screen.getByText("What to look for before approving.")).toBeTruthy();
    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.getByText("Grep")).toBeTruthy();
  });

  it("names every persona that carries it — the reverse index the Skills page never had", () => {
    render(<TeamsInspector {...props} sel={{ type: "skill", id: "sk-review" }} />);
    expect(screen.getByText("carried by 1")).toBeTruthy();
    expect(screen.getByText("Reviewer")).toBeTruthy();
  });

  it("says plainly when a skill reaches NO agent, rather than showing an empty row", () => {
    // A skill in the library that no persona carries is inert. That is worth stating: it looks
    // identical to a working one on a page that only lists skills.
    render(<TeamsInspector {...props} sel={{ type: "skill", id: "sk-orphan" }} />);
    expect(screen.getByText(/reaches no agent/)).toBeTruthy();
  });

  it("names `bsc skill` as the write path", () => {
    render(<TeamsInspector {...props} sel={{ type: "skill", id: "sk-review" }} />);
    expect(screen.getByText("bsc skill")).toBeTruthy();
  });

  it("a selected skill that is not in the library renders empty rather than throwing", () => {
    const { container } = render(<TeamsInspector {...props} sel={{ type: "skill", id: "sk-gone" }} />);
    expect(container.textContent).toBe("");
  });

  it("ships no editing control", () => {
    const { container } = render(<TeamsInspector {...props} sel={{ type: "skill", id: "sk-review" }} />);
    expect(editingControls(container)).toHaveLength(0);
  });
});

describe("TeamsInspector — a persona's skills resolve to names", () => {
  const review = { id: "sk-review", name: "Code review checklist", kind: "procedure", source: "user",
    desc: "", prompt: "", tools: [], profiles: [], projects: [], enabled: true, pinned: false } as unknown as SkillDef;
  const carrier: Persona = {
    id: "p-carrier", name: "Reviewer", blurb: "", role: "reviewer", startPrompt: "",
    skills: ["sk-review", "sk-vanished"],
  };
  const team: Team = {
    id: "o4", name: "Names", relationships: [],
    positions: [{ nodeId: "n1", kind: "agent", personaId: "p-carrier" }],
  };
  const props = {
    org: team, orgs: [team], personas: [carrier], skills: [review],
    onSelectNode: () => {}, onSelectSkill: () => {}, onSelectPersona: () => {},
  };

  it("renders the skill's NAME, not its id", () => {
    render(<TeamsInspector {...props} sel={{ type: "node", id: "n1" }} />);
    expect(screen.getByText("Code review checklist")).toBeTruthy();
    expect(screen.queryByText("sk-review")).toBeNull();
  });

  it("keeps an UNRESOLVABLE id visible instead of silently dropping it", () => {
    // The launch will still try to write `sk-vanished` into `.claude/skills/`. If the panel is the one
    // place that pretends it is not there, the persona reads as having fewer skills than it does.
    render(<TeamsInspector {...props} sel={{ type: "node", id: "n1" }} />);
    expect(screen.getByText("sk-vanished")).toBeTruthy();
  });
});

describe("what the agent does automatically — hooks and schedules", () => {
  // These moved off the retired Automations page onto the persona that carries them. The panel is
  // the ONLY place either is now visible, so a section that renders nothing is indistinguishable
  // from a feature that does not exist — which is exactly how the first version shipped.
  const bare: Persona = {
    id: "p-bare", name: "Bare", blurb: "", role: "worker", startPrompt: "", skills: [],
  };
  const carrier: Persona = {
    id: "p-carrier", name: "Carrier", blurb: "", role: "worker", startPrompt: "", skills: [],
    hooks: [
      { event: "PreToolUse", matcher: "Bash", command: "bsc-audit" },
      { event: "PostToolUse", command: "bsc-note landed" },
    ],
    schedules: [
      { name: "nightly-gc", when: { kind: "cron", expr: "0 2 * * *" }, command: "npm run gc" },
      { name: "paused", when: { kind: "cron", expr: "0 9 * * *" }, command: "echo hi", armed: false },
    ],
  };
  const team = (p: Persona): Team => ({
    id: "o5", name: "Carriers", relationships: [],
    positions: [{ nodeId: "n1", kind: "agent", personaId: p.id }],
  });
  const props = (p: Persona) => ({
    org: team(p), orgs: [team(p)], personas: [p], skills: [],
    onSelectNode: () => {}, onSelectSkill: () => {}, onSelectPersona: () => {},
    sel: { type: "node", id: "n1" } as const,
  });

  it("shows BOTH sections for a persona carrying neither, and names how to author one", () => {
    // The regression that shipped: the whole block was wrapped in a truthiness check, so on the
    // normal install — where nobody has authored one yet — the panel showed nothing at all and the
    // feature looked missing rather than unused.
    render(<TeamsInspector {...props(bare)} />);
    // The HEADING is the signal: the old code rendered no element at all, so asserting on the
    // zero-count heading is what distinguishes "carries none" from "section does not exist".
    expect(screen.getByText(/^hooks . 0$/)).toBeTruthy();
    expect(screen.getByText(/^schedules . 0$/)).toBeTruthy();
    // Read-only panel, so each empty state has to say where the authoring happens. Scoped to the
    // sections deliberately: `bsc persona set` ALSO appears in this panel's denied-commands list
    // for a role that may not run it, so a whole-document count is not the assertion it looks like.
    expect(screen.getAllByText(/^none . add one with/).length).toBe(2);
  });

  it("counts what the persona carries in each heading", () => {
    render(<TeamsInspector {...props(carrier)} />);
    expect(screen.getByText(/hooks.*2/)).toBeTruthy();
    expect(screen.getByText(/schedules.*2/)).toBeTruthy();
  });

  it("spells out an ABSENT matcher as every tool", () => {
    // An empty matcher means the hook fires on every tool — a far bigger statement than a narrow
    // one. Rendering it as blank reads as "nothing configured" and hides the broadest case there is.
    render(<TeamsInspector {...props(carrier)} />);
    expect(screen.getByText("every tool")).toBeTruthy();
    expect(screen.getByText("Bash")).toBeTruthy();
  });

  it("marks a disarmed schedule and leaves an armed one unmarked", () => {
    // `armed` defaults to TRUE, matching the scheduler's own default — if the panel defaulted the
    // other way it would show a live job as paused.
    render(<TeamsInspector {...props(carrier)} />);
    expect(screen.getByText("nightly-gc")).toBeTruthy();
    expect(screen.getByText("paused")).toBeTruthy();
    expect(screen.getAllByText("disarmed").length).toBe(1);
  });

  it("renders each hook's command and each schedule's trigger", () => {
    render(<TeamsInspector {...props(carrier)} />);
    expect(screen.getByText("bsc-audit")).toBeTruthy();
    expect(screen.getByText("npm run gc")).toBeTruthy();
    expect(screen.getByText("0 2 * * *")).toBeTruthy();
  });
});
