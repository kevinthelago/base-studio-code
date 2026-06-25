// LLM rubric grader (#615 slice d). For prose sections a checklist can't judge, ask
// Claude to score the section content against the rubric and return structured findings.
// Advisory (shown as the "Claude review" grader tab). The pure logic (prompt + parse)
// takes an injected `complete` so it's testable; runSectionGradeLLM wires it to kb_chat.

import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { type LlmConfig, hasLlmKey } from "@/shared/lib/core/llmConfig";
import { letterFromScore } from "@/features/planner/lib/planGrade";
import { rubricForSection, type GradeResult, type GradeDimension, type GradeFinding, type Severity, type Rubric } from "./grading";

export const GRADE_LLM_ID = "grade-llm";
const GRADER_LABEL = "Claude review";

export interface GradePrompt { system: string; user: string }
/** A one-shot completion: prompt → model text. Injected so the grader is testable. */
export type Complete = (p: GradePrompt) => Promise<string>;

export function buildGradePrompt(rubric: Rubric, sectionKey: string, content: string): GradePrompt {
  return {
    system:
      "You are a meticulous software-planning reviewer. Grade the given plan section against the rubric " +
      "dimensions. Respond with ONLY a JSON object, no prose, of the form: " +
      '{"score":0-100,"dimensions":[{"label":string,"score":0-100,"note":string}],' +
      '"findings":[{"severity":"info"|"warn"|"error","message":string,"fix":string}]}.',
    user:
      `Section: ${sectionKey}\n` +
      `Rubric dimensions: ${rubric.dimensions.map((d) => d.label).join(", ") || "(general quality)"}\n\n` +
      `Section content:\n${content.trim() || "(empty)"}`,
  };
}

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));
const SEVS: Severity[] = ["info", "warn", "error"];
const sev = (s: unknown): Severity => (SEVS.includes(s as Severity) ? (s as Severity) : "warn");

/** Parse the model's JSON into a GradeResult; malformed output yields an error finding. */
export function parseLLMGrade(raw: string, sectionKey: string): GradeResult {
  const fail = (message: string): GradeResult => ({
    graderId: GRADE_LLM_ID, graderLabel: GRADER_LABEL, sectionKey, score: 0, letter: "F",
    dimensions: [], findings: [{ severity: "error", message }],
  });
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return fail("Claude's response wasn't valid JSON.");
  let obj: { score?: number; dimensions?: unknown; findings?: unknown };
  try { obj = JSON.parse(m[0]); } catch { return fail("Claude's response wasn't valid JSON."); }

  const score = clamp(typeof obj.score === "number" ? obj.score : 0);
  const dimensions: GradeDimension[] = Array.isArray(obj.dimensions)
    ? obj.dimensions.map((d, i) => {
        const o = (d ?? {}) as { label?: string; score?: number; note?: string };
        return { id: `d${i}`, label: o.label ?? `Dimension ${i + 1}`, score: clamp(o.score ?? 0), note: o.note };
      })
    : [];
  if (dimensions.length === 0) dimensions.push({ id: "overall", label: "Overall", score });
  const findings: GradeFinding[] = Array.isArray(obj.findings)
    ? obj.findings.map((f) => {
        const o = (f ?? {}) as { severity?: string; message?: string; fix?: string };
        return { severity: sev(o.severity), message: o.message ?? "(no message)", fix: o.fix };
      })
    : [];
  return { graderId: GRADE_LLM_ID, graderLabel: GRADER_LABEL, sectionKey, score, letter: letterFromScore(score / 100), dimensions, findings };
}

/** Grade a section with the LLM (pure given `complete`). */
export async function gradeWithLLM(rubric: Rubric, input: { sectionKey: string; content?: string }, complete: Complete): Promise<GradeResult> {
  const raw = await complete(buildGradePrompt(rubric, input.sectionKey, input.content ?? ""));
  return parseLLMGrade(raw, input.sectionKey);
}

/** A kb_chat-backed one-shot completion, routed through the active provider (#1085). */
async function kbComplete(llm: LlmConfig, p: GradePrompt): Promise<string> {
  const res = await invoke<{ content: { type: string; text?: string }[] }>("kb_chat", {
    messages: [{ role: "user", content: p.user }], system: p.system, tools: [],
    apiKey: llm.apiKey, provider: llm.provider, model: llm.model, baseUrl: llm.baseUrl,
  });
  return (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}

export interface RunLLMGradeArgs { projectKey: string; sectionKey: string; content?: string; llm: LlmConfig }

/** Run the LLM grader for a section and persist the result. Throws if no API key. */
export async function runSectionGradeLLM({ projectKey, sectionKey, content, llm }: RunLLMGradeArgs): Promise<GradeResult> {
  if (!hasLlmKey(llm)) throw new Error(`No API key for ${llm.provider} — add one in Settings → Integrations.`);
  const result = await gradeWithLLM(rubricForSection(sectionKey), { sectionKey, content }, (p) => kbComplete(llm, p));
  useAppStore.getState().setSectionGrade(projectKey, sectionKey, result);
  return result;
}
