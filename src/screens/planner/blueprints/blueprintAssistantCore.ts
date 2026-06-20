// "Design with Claude" assistant logic (#609 slice 6) — pure. Maps a free-text request
// to concrete, always-valid blueprint actions, and applies them to a BlueprintSection[]
// via the slice-2 edit helpers. The drawer (BlueprintAssistant.tsx) renders proposals
// from these and applies on confirm.
//
// v1 is a deterministic HEURISTIC (no network) — useful on its own. Wiring the prose to
// the real Claude API is a follow-up; the actions are real either way.

import { type BlueprintSection } from "../stages/blueprints";
import { stageKind } from "./blueprintCatalog";
import { addStage, deleteStage, addSkill } from "./blueprintEdit";

export type AssistantAction =
  | { op: "add"; kind: string }
  | { op: "remove"; kind: string }
  // Skill actions (#636 slice c): attach an existing library skill, or author a new one.
  | { op: "attach-skill"; kind: string; skillId: string; skillName: string }
  | { op: "create-skill"; kind: string; name: string; content: string };

/** Map a request to stage actions over the current sections. Never invents duplicates. */
export function planActions(text: string, sections: BlueprintSection[]): AssistantAction[] {
  const t = text.toLowerCase();
  const have = new Set(sections.map((s) => s.key));
  const actions: AssistantAction[] = [];
  const add = (kind: string) => { if (!have.has(kind)) { actions.push({ op: "add", kind }); have.add(kind); } };

  if (/secur|threat|audit|secret/.test(t)) add("security");
  if (/test|coverage|qa/.test(t)) add("testing");
  if (/observ|logging|metric|monitor|trace|tracing/.test(t)) add("observability");
  if (/contract|api|endpoint/.test(t)) { add("schema"); add("api"); }
  if (/preview|ui|screen|design|frontend/.test(t)) add("ui");
  if (/infra|deploy|hosting|cloud/.test(t)) add("infra");
  if (/\bci\b|\bcd\b|release|build pipeline/.test(t)) add("cicd");
  if (/doc|readme|guide/.test(t)) add("docs");
  if (/persona|user research|audience/.test(t)) add("users");

  if (/mvp|trim|lean|minimal|cut|simplify|fast/.test(t)) {
    for (const k of ["observability", "infra", "docs", "cicd", "security"]) {
      if (have.has(k)) actions.push({ op: "remove", kind: k });
    }
  }
  return actions;
}

/** Apply assistant actions to a sections array (pure, via the edit helpers). */
export function applyAssistantActions(sections: BlueprintSection[], actions: AssistantAction[]): BlueprintSection[] {
  let a = [...sections];
  for (const act of actions) {
    if (act.op === "add") {
      a = addStage(a, act.kind);
    } else if (act.op === "remove") {
      for (const v of a.filter((s) => s.key === act.kind)) a = deleteStage(a, v.uid);
    } else if (act.op === "attach-skill") {
      // create-skill is materialized into the library + rewritten as attach-skill by the
      // drawer before apply, so only attach reaches here.
      const sec = a.find((s) => s.key === act.kind);
      if (sec) a = addSkill(a, sec.uid, act.skillId);
    }
  }
  return a;
}

export interface ActionLine { type: "add" | "del" | "mod"; title: string; note: string; h: number; glyph: string }

/** One renderable line for a proposed action. */
export function actionLine(a: AssistantAction): ActionLine {
  const k = stageKind(a.kind);
  if (a.op === "add") return { type: "add", title: k.title, note: "new stage", h: k.h, glyph: k.glyph };
  if (a.op === "remove") return { type: "del", title: k.title, note: "remove stage", h: k.h, glyph: k.glyph };
  if (a.op === "attach-skill") return { type: "mod", title: a.skillName, note: `attach skill → ${k.title}`, h: k.h, glyph: "extension" };
  return { type: "add", title: a.name, note: `new skill → ${k.title}`, h: k.h, glyph: "extension" }; // create-skill
}

/** Heuristic prose summarizing the proposed actions. */
export function proseFor(actions: AssistantAction[]): string {
  if (actions.length === 0) {
    return "I couldn't map that to a concrete stage change yet. Try naming a concern — security, testing, API contracts, UI preview, observability — or ask me to trim it to an MVP.";
  }
  const adds = actions.filter((a) => a.op === "add").length;
  const dels = actions.filter((a) => a.op === "remove").length;
  const skills = actions.filter((a) => a.op === "attach-skill" || a.op === "create-skill").length;
  const bits: string[] = [];
  if (adds) bits.push(`add ${adds} stage${adds > 1 ? "s" : ""}`);
  if (dels) bits.push(`drop ${dels} stage${dels > 1 ? "s" : ""}`);
  if (skills) bits.push(`attach ${skills} skill${skills > 1 ? "s" : ""}`);
  return `Here's a focused change: I'd ${bits.join(", ")}. Dependencies are ordered so each stage stays locked until its prerequisites land. Review and apply, or refine the ask.`;
}

/** A one-shot completion (prompt → text), injected so prose generation is testable. */
export type Complete = (p: { system: string; user: string }) => Promise<string>;

function summarizeAction(a: AssistantAction): string {
  if (a.op === "add") return `add ${a.kind}`;
  if (a.op === "remove") return `remove ${a.kind}`;
  if (a.op === "attach-skill") return `attach skill "${a.skillName}" to ${a.kind}`;
  return `create skill "${a.name}" on ${a.kind}`; // create-skill
}

/**
 * Generate the assistant's explanation prose. With actions + a live completion, ask
 * Claude for one concrete sentence; with no actions (or any error, handled by the
 * caller) fall back to {@link proseFor}. The proposed ACTIONS stay deterministic — only
 * the wording comes from the model.
 */
export async function explainActions(actions: AssistantAction[], blueprintName: string, complete: Complete): Promise<string> {
  if (actions.length === 0) return proseFor(actions);
  const raw = await complete({
    system:
      "You are a planning-blueprint designer for a multi-agent dev tool. In ONE short sentence " +
      "(max 28 words), explain the proposed change to the blueprint. Be concrete and confident. " +
      "No preamble, no lists.",
    user: `Blueprint: ${blueprintName}. Proposed actions: ${actions.map(summarizeAction).join("; ")}.`,
  });
  return raw.trim() || proseFor(actions);
}

export const ASSISTANT_SUGGESTIONS = [
  "Make it contract-first with API gates",
  "Add a security review stage",
  "Gate the UI design stage with render-preview",
  "Make a skill for our coding conventions",
  "Trim it down to a lean MVP",
];

// ── skills: detect intent, author content (#636 slice c) ──────────────────────

/** Whether a request is about authoring a NEW skill ("make/create/draft/write a skill…"). */
export function isCreateSkillRequest(text: string): boolean {
  return /\b(make|create|draft|write|author|add)\b[^.]*\bskill\b/i.test(text) && !/\battach\b/i.test(text);
}
/** Whether a request is about attaching an EXISTING skill ("attach the X skill…"). */
export function isAttachSkillRequest(text: string): boolean {
  return /\battach\b[^.]*\bskill\b/i.test(text) || /\bskill\b[^.]*\battach\b/i.test(text);
}

/** Pick the section a skill request targets: a section whose key/name is named in the
 *  text, else the first section. Returns undefined when there are no sections. */
export function inferSkillKind(text: string, sections: BlueprintSection[]): string | undefined {
  const t = text.toLowerCase();
  const named = sections.find((s) => t.includes(s.key.toLowerCase()) || t.includes(s.name.toLowerCase()));
  return (named ?? sections[0])?.key;
}

/** Ask Claude to author a reusable skill from a free-text request. Pure given `complete`;
 *  tolerant of prose/fenced JSON. Falls back to a stub name + the request as content. */
export async function authorSkill(request: string, complete: Complete): Promise<{ name: string; content: string }> {
  let raw = "";
  try {
    raw = await complete({
      system:
        "You author reusable engineering SKILLS for AI coding agents. From the user's request, write ONE skill: " +
        "a short Title-Case name and a concise markdown body of concrete, actionable guidance (conventions, steps, " +
        "examples). Respond with ONLY JSON: {\"name\":string,\"content\":string}.",
      user: request,
    });
  } catch { /* fall through to stub */ }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as { name?: string; content?: string };
      if (o.content?.trim()) return { name: (o.name || "New skill").trim(), content: o.content.trim() };
    } catch { /* fall through */ }
  }
  return { name: "New skill", content: request.trim() };
}
