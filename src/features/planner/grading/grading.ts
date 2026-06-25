// Pluggable per-section grading (#615). A grader scores one section and returns a
// GradeResult; a section can carry MULTIPLE graders (attached as stage modules). This slice
// is the contract + a deterministic, data-driven **rubric grader** — each dimension is
// either a signal gate (reusing #584's evalGate over PlanSignals) or a declarative
// content heuristic. Rubrics are plain data, so they ride blueprints and stay
// WAN-distributable, exactly like the gate rules. Pure; the stage screen renders the
// result and the runtime persists it (slice b).

import { type PlanSignals, type StageGate, evalGate } from "../stages/stageGate";
import { letterFromScore, type Letter } from "@/features/planner/lib/planGrade";

export type Severity = "info" | "warn" | "error";
export interface GradeFinding { severity: Severity; message: string; fix?: string }
export interface GradeDimension { id: string; label: string; score: number; note?: string }

/** One grader's verdict for one section. score is 0–100; letter is derived. */
export interface GradeResult {
  graderId: string;
  graderLabel: string;
  sectionKey: string;
  score: number;
  letter: Letter;
  dimensions: GradeDimension[];
  findings: GradeFinding[];
  /** Opaque richer payload some graders carry (e.g. agent-readiness keeps its full
   *  PlanGrade for the structure section's detailed report). The report card ignores it;
   *  a bespoke renderer can use it. */
  detail?: unknown;
}

/** What a grader gets: the section, the live signal bag, and (for prose) its content. */
export interface GradeInput { sectionKey: string; signals: PlanSignals; content?: string }

// ── declarative content heuristics (deterministic, no LLM) ────────────────────
export type ContentRule =
  | { rule: "min-length"; chars: number }
  | { rule: "has-structure" }                 // markdown headings or list items
  | { rule: "no-placeholders" }               // no TODO/TBD/FIXME/WIP/??? / lorem
  | { rule: "mentions"; any: string[] };      // share of key terms present

const PLACEHOLDER = /\b(TODO|TBD|FIXME|WIP|lorem ipsum)\b/i;

/** Score a content rule 0–100 against a section's markdown. */
export function scoreContentRule(rule: ContentRule, content: string): number {
  const text = content ?? "";
  switch (rule.rule) {
    case "min-length": {
      const n = text.trim().length;
      return Math.max(0, Math.min(100, Math.round((n / rule.chars) * 100)));
    }
    case "has-structure":
      return /^#{1,6}\s/m.test(text) || /^\s*[-*+]\s/m.test(text) || /^\s*\d+\.\s/m.test(text) ? 100 : 0;
    case "no-placeholders":
      return PLACEHOLDER.test(text) || text.includes("???") ? 0 : 100;
    case "mentions": {
      if (rule.any.length === 0) return 100;
      const lc = text.toLowerCase();
      const hits = rule.any.filter((k) => lc.includes(k.toLowerCase())).length;
      return Math.round((hits / rule.any.length) * 100);
    }
  }
}

// ── rubric model ──────────────────────────────────────────────────────────────
export interface RubricDimension {
  id: string;
  label: string;
  /** Relative weight in the overall score (default 1). */
  weight?: number;
  /** Signal-based: score = evalGate(...).fraction · 100. */
  signal?: StageGate;
  /** Content-based: score = scoreContentRule(...). */
  content?: ContentRule;
  /** Shown as the finding message when this dimension underperforms. */
  hint?: string;
}

export interface Rubric {
  id: string;
  label: string;
  /** Section kind this rubric grades ("*" = any). */
  sectionKey: string;
  dimensions: RubricDimension[];
}

const PASS = 80; // a dimension at/above this is considered satisfied (no finding)

/** Grade a section with one rubric. Pure + deterministic. */
export function gradeWithRubric(rubric: Rubric, input: GradeInput): GradeResult {
  const dims: GradeDimension[] = rubric.dimensions.map((d) => {
    const score = d.signal
      ? Math.round(evalGate(d.signal, input.signals).fraction * 100)
      : d.content
        ? scoreContentRule(d.content, input.content ?? "")
        : 0;
    return { id: d.id, label: d.label, score, note: d.hint };
  });
  const totW = rubric.dimensions.reduce((s, d) => s + (d.weight ?? 1), 0) || 1;
  const score = Math.round(rubric.dimensions.reduce((s, d, i) => s + dims[i].score * (d.weight ?? 1), 0) / totW);
  const findings: GradeFinding[] = [];
  dims.forEach((dim, i) => {
    if (dim.score >= PASS) return;
    findings.push({
      severity: dim.score < 50 ? "error" : "warn",
      message: rubric.dimensions[i].hint ?? `${dim.label} needs more detail`,
    });
  });
  return { graderId: rubric.id, graderLabel: rubric.label, sectionKey: input.sectionKey, score, letter: letterFromScore(score / 100), dimensions: dims, findings };
}

// ── default per-section-kind rubrics (deterministic, content-based) ────────────
const sub = (chars = 200): RubricDimension => ({ id: "substance", label: "Substance", content: { rule: "min-length", chars }, hint: "Add more detail — this section is thin." });
const noTodo: RubricDimension = { id: "resolved", label: "No placeholders", content: { rule: "no-placeholders" }, hint: "Resolve TODO / TBD / placeholder text." };
const structured: RubricDimension = { id: "structured", label: "Structured", content: { rule: "has-structure" }, hint: "Use headings or bullet points." };
const mentions = (id: string, label: string, any: string[], hint: string): RubricDimension => ({ id, label, content: { rule: "mentions", any }, hint });

function rubric(sectionKey: string, label: string, dimensions: RubricDimension[]): Rubric {
  return { id: `rubric:${sectionKey}`, label, sectionKey, dimensions };
}

/** Built-in rubric per section kind, plus a generic fallback. */
export const RUBRICS: Record<string, Rubric> = {
  context:      rubric("context", "Context rubric", [sub(200), noTodo, mentions("goals", "Goals & success", ["goal", "success", "constraint"], "State goals, success criteria, and constraints.")]),
  scope:        rubric("scope", "Scope rubric", [sub(150), mentions("boundary", "Boundary", ["in scope", "out of scope", "mvp", "non-goal"], "Mark what's in vs out of scope.")]),
  stack:        rubric("stack", "Stack rubric", [sub(150), mentions("choices", "Choices", ["framework", "language", "version", "runtime"], "Name frameworks, languages, and pinned versions.")]),
  architecture: rubric("architecture", "Architecture rubric", [sub(300), structured, mentions("design", "Design", ["component", "service", "boundary", "data flow"], "Describe components, boundaries, and data flow.")]),
  schema:       rubric("schema", "Data-model rubric", [sub(150), mentions("model", "Model", ["entity", "relation", "migration", "index"], "Cover entities, relations, and migrations.")]),
  api:          rubric("api", "API rubric", [sub(150), mentions("contract", "Contract", ["endpoint", "request", "response", "error", "auth"], "Specify endpoints, request/response, errors, and auth.")]),
  ui:           rubric("ui", "UI rubric", [sub(150), mentions("screens", "Screens & states", ["screen", "flow", "empty", "loading", "error"], "Enumerate screens and their empty/loading/error states.")]),
  structure:    rubric("structure", "Structure rubric", [sub(120), noTodo, structured]),
  permissions:  rubric("permissions", "Permissions rubric", [mentions("least", "Least privilege", ["least", "scope", "glob", "write", "read"], "Describe least-privilege scoping per agent.")]),
  testing:      rubric("testing", "Testing rubric", [sub(120), mentions("strategy", "Strategy", ["coverage", "unit", "integration", "gate"], "Name coverage targets, test types, and gates.")]),
  security:     rubric("security", "Security rubric", [sub(150), mentions("posture", "Posture", ["threat", "secret", "auth", "access"], "Cover threat model, secrets, and access control.")]),
};

const GENERIC = rubric("*", "Section rubric", [sub(120), structured, noTodo]);

/** The default rubric(s) for a section kind. Multiple-per-section comes later from the
 *  blueprint (attached grader stage modules); this returns the built-in default. */
export function rubricForSection(sectionKey: string): Rubric {
  return RUBRICS[sectionKey] ?? GENERIC;
}
