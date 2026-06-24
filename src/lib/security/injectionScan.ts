// Prompt-injection detector (#1107). A pure, deterministic scan for the high-signal markers of an
// injected/hijacking instruction — the kind a poisoned repo or web page tries to smuggle through the
// planner into the fleet's trusted kickoffs. Used two ways:
//
//   1. The planner provenance gate (#1107): scan planner-authored artifacts (section files,
//      kickoffs, profiles) BEFORE they seed a worker, and surface flags to the user at the existing
//      confirmation boundary. A flag is human-reviewed, not auto-rejected — the planner's output
//      legitimately contains instructions, so the goal is to catch the *malicious* ones.
//   2. Shared detectors for the #1102 fleet warden, which can run the same `scanText` over what a
//      worker reads/writes.
//
// Deterministic + no LLM on purpose: the scan can't itself be prompt-injected. Patterns are tuned
// for HIGH SIGNAL (override phrasing, secret exfiltration, permission/safety bypass) over recall —
// false positives are a quick user dismissal; missed injections are a fleet compromise, but a noisy
// scan gets ignored, so the bar is "rarely appears in a legitimate plan".

/** A category of injection marker — drives how a finding is explained and grouped. */
export type InjectionCategory =
  | "override"      // "ignore previous instructions", role/identity hijack
  | "exfiltration"  // send secrets/env or repo contents to an external destination
  | "perms"         // skip/disable permissions, sandbox, or safety checks
  | "destructive"   // force-push, delete repo, self-merge, rm -rf
  | "ci";           // disable/bypass CI, workflows, or git hooks

export interface InjectionFinding {
  /** The artifact the marker was found in (e.g. `prompts/auth-kickoff.md`). */
  file: string;
  /** 1-based line number of the match. */
  line: number;
  category: InjectionCategory;
  /** Human label for the category. */
  label: string;
  /** The matched substring, trimmed for display. */
  match: string;
  /** The whole line (trimmed/clamped), so the user sees the marker in context. */
  context: string;
}

interface Pattern { category: InjectionCategory; label: string; re: RegExp }

// Each pattern targets a marker that is hostile in any plan deliverable and rare in legitimate ones.
// Verbs are required (not bare nouns) so that *describing* a subsystem ("the CI pipeline", "stores a
// token") doesn't trip — only *instructing* a hostile action does.
const PATTERNS: Pattern[] = [
  // Classic prompt-injection override / identity hijack. A legitimate plan never instructs this.
  { category: "override", label: "instruction-override phrasing",
    re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|the)?\s*(instructions?|directions?|rules?|prompts?|protocol|guardrails?|system\s*prompt)\b/i },
  { category: "override", label: "role / identity hijack",
    re: /(\byou are now\b|\bact as (an?\s+)?(unrestricted|jailbro|root|admin)|new\s+instructions\s*:|from now on[, ]+(ignore|disregard|you)|^\s*system\s*:\s*)/im },

  // Secret / environment / repo-content exfiltration. Each noun carries its own boundary so the
  // dot-prefixed forms (`.env`) match; `[^\n]` keeps it on one line but tolerates dots between.
  { category: "exfiltration", label: "secret or environment exfiltration",
    re: /\b(send|post|upload|exfiltrate|transmit|leak|curl|wget|fetch)\b[^\n]{0,60}(\benv(ironment)?\b|\bsecrets?\b|\btokens?\b|\bcredentials?\b|\bapi[\s_-]?keys?\b|\bpasswords?\b|\.env\b|\bprintenv\b)/i },
  { category: "exfiltration", label: "post data to an external destination",
    re: /\b(send|post|upload|exfiltrate|transmit|curl|wget)\b[^\n]{0,60}https?:\/\//i },

  // Permission / safety / sandbox bypass.
  { category: "perms", label: "permission or safety bypass",
    re: /(--dangerously[\w-]*|\bskip[\s-]?permissions?\b|\bdisable\b[^.\n]{0,30}\b(security|safety|sandbox|guard|protection|check|review|audit)\b|\bsudo\s|\bchmod\s+777\b|\bbypass\b[^.\n]{0,30}\b(security|permission|guard|sandbox|gate)\b)/i },

  // Destructive or out-of-lane git / GitHub operations.
  { category: "destructive", label: "destructive or out-of-lane git/GitHub op",
    re: /(git\s+push\s+(-f\b|--force)|\bforce[\s-]?push\b|gh\s+repo\s+delete\b|\brm\s+-rf\s+[/~]|git\s+push\b[^.\n]{0,40}\b(main|master)\b)/i },

  // CI / workflow / git-hook tampering — hostile verbs only (authoring a workflow is fine).
  { category: "ci", label: "CI/CD or git-hook tampering",
    re: /\b(disable|skip|bypass|turn\s+off|remove|delete)\b[^.\n]{0,30}(\.github\/workflows|\.git\/hooks|ci\/cd|\bci\b|pipeline|pre-?commit|\bhooks?\b|workflow)\b/i },
];

/** Scan one text blob for injection markers — first match per line per pattern. Pure. */
export function scanText(text: string): Omit<InjectionFinding, "file">[] {
  const out: Omit<InjectionFinding, "file">[] = [];
  const lines = (text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const p of PATTERNS) {
      const m = p.re.exec(line);
      if (m) {
        out.push({
          line: i + 1,
          category: p.category,
          label: p.label,
          match: m[0].trim().slice(0, 120),
          context: line.trim().slice(0, 200),
        });
      }
    }
  }
  return out;
}

/** Scan a set of named artifacts (file → content). Pure; the planner gate's entry point. */
export function scanArtifacts(artifacts: Record<string, string>): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const [file, content] of Object.entries(artifacts)) {
    for (const f of scanText(content)) findings.push({ file, ...f });
  }
  return findings;
}
