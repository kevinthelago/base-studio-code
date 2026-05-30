// Minimal, tolerant parser for the three GitHub Actions workflow blocks the
// Actions screen renders in "structured" mode: `on:` triggers, top-level `env:`,
// and `jobs:`. It is NOT a general YAML parser — it only walks the shallow,
// well-known shapes Actions files use, and degrades to empty/“—” rather than
// throwing on anything it doesn't recognize. The Actions view previously hardcoded
// this data (#141); this turns it into the workflow's real configuration.

export interface WorkflowTrigger {
  /** The event name, e.g. `push`, `pull_request`, `schedule`, `workflow_dispatch`. */
  name: string;
  /** A short human summary of the trigger's config, or null when it has none. */
  detail: string | null;
}

export interface WorkflowEnv {
  key: string;
  value: string;
}

export interface WorkflowJob {
  /** The job's YAML key (its id). */
  id: string;
  /** The job's `name:` if set, else null (callers fall back to the id). */
  name: string | null;
  /** The `runs-on:` value verbatim (may be an expression), or "—" when absent. */
  runsOn: string;
  /** Short labels for each step (its name, else action basename, else run head). */
  steps: string[];
}

export interface ParsedWorkflow {
  on: WorkflowTrigger[];
  env: WorkflowEnv[];
  jobs: WorkflowJob[];
}

interface Line {
  indent: number;
  text: string;
}

/** Leading-space count; YAML forbids tabs for indentation so we only count spaces. */
function indentOf(raw: string): number {
  let n = 0;
  while (n < raw.length && raw[n] === " ") n++;
  return n;
}

/** Strip a trailing ` # comment`, but only when the `#` is not inside a quote. */
function stripComment(s: string): string {
  let qc: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (qc) {
      if (ch === qc) qc = null;
    } else if (ch === '"' || ch === "'") {
      qc = ch;
    } else if (ch === "#" && i > 0 && s[i - 1] === " ") {
      return s.slice(0, i);
    }
  }
  return s;
}

/** Tokenize into non-blank, non-comment lines carrying their indent. */
function tokenize(yaml: string): Line[] {
  const out: Line[] = [];
  for (const raw of yaml.replace(/\r\n/g, "\n").split("\n")) {
    const noComment = stripComment(raw);
    const trimmed = noComment.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    out.push({ indent: indentOf(noComment), text: trimmed });
  }
  return out;
}

/** Remove matching surrounding single/double quotes from a scalar. */
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

/** Parse an inline flow sequence `[a, b, c]` into trimmed, unquoted items. */
function parseFlowSeq(s: string): string[] {
  const inner = s.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return inner.split(",").map((x) => unquote(x)).filter(Boolean);
}

/** The block of lines strictly more indented than `parentIndent`, starting at `from`. */
function blockOf(lines: Line[], from: number, parentIndent: number): Line[] {
  const out: Line[] = [];
  for (let i = from; i < lines.length; i++) {
    if (lines[i].indent <= parentIndent) break;
    out.push(lines[i]);
  }
  return out;
}

/** Split `key: value` at the first top-level colon; value may be empty. */
function splitKey(text: string): { key: string; value: string } | null {
  const idx = text.indexOf(":");
  if (idx < 0) return null;
  return { key: text.slice(0, idx).trim(), value: text.slice(idx + 1).trim() };
}

/** Find the top-level (indent 0) entry whose key matches any of `keys`. */
function findTop(lines: Line[], keys: string[]): number {
  return lines.findIndex((l) => {
    if (l.indent !== 0) return false;
    const kv = splitKey(l.text);
    return kv != null && keys.includes(unquote(kv.key));
  });
}

function summarizeTrigger(body: Line[]): string | null {
  if (body.length === 0) return null;
  // branches / branches-ignore for push & pull_request
  const branchesLine = body.find((l) => {
    const kv = splitKey(l.text);
    return kv != null && (kv.key === "branches" || kv.key === "tags");
  });
  if (branchesLine) {
    const kv = splitKey(branchesLine.text)!;
    let items: string[];
    if (kv.value.startsWith("[")) {
      items = parseFlowSeq(kv.value);
    } else {
      // block list of `- main`
      const sub = blockOf(body, body.indexOf(branchesLine) + 1, branchesLine.indent);
      items = sub
        .filter((l) => l.text.startsWith("- "))
        .map((l) => unquote(l.text.slice(2)));
    }
    if (items.length) return `${kv.key}: ${items.join(", ")}`;
  }
  // schedule: cron expressions
  const crons = body
    .map((l) => splitKey(l.text.replace(/^-\s*/, "")))
    .filter((kv): kv is { key: string; value: string } => kv != null && kv.key === "cron")
    .map((kv) => unquote(kv.value));
  if (crons.length) return `cron: ${crons.join(", ")}`;
  return null;
}

function parseOn(lines: Line[]): WorkflowTrigger[] {
  const i = findTop(lines, ["on"]);
  if (i < 0) return [];
  const { value } = splitKey(lines[i].text)!;
  // Inline scalar: `on: push`
  if (value && !value.startsWith("[")) return [{ name: unquote(value), detail: null }];
  // Inline flow seq: `on: [push, pull_request]`
  if (value.startsWith("[")) return parseFlowSeq(value).map((name) => ({ name, detail: null }));
  // Block form: child keys are event names.
  const block = blockOf(lines, i + 1, lines[i].indent);
  if (block.length === 0) return [];
  const childIndent = block[0].indent;
  const triggers: WorkflowTrigger[] = [];
  for (let j = 0; j < block.length; j++) {
    if (block[j].indent !== childIndent) continue;
    const kv = splitKey(block[j].text);
    if (!kv) {
      // e.g. a bare `- workflow_dispatch` (rare); skip non key/val
      continue;
    }
    const body = blockOf(block, j + 1, block[j].indent);
    triggers.push({ name: unquote(kv.key), detail: summarizeTrigger(body) });
  }
  return triggers;
}

function parseEnv(lines: Line[]): WorkflowEnv[] {
  const i = findTop(lines, ["env"]);
  if (i < 0) return [];
  const block = blockOf(lines, i + 1, lines[i].indent);
  if (block.length === 0) return [];
  const childIndent = block[0].indent;
  const out: WorkflowEnv[] = [];
  for (const l of block) {
    if (l.indent !== childIndent) continue;
    const kv = splitKey(l.text);
    if (kv && kv.key) out.push({ key: kv.key, value: unquote(kv.value) });
  }
  return out;
}

/** Short label for a single step from its `name` / `uses` / `run`. */
function stepLabel(stepBody: Line[]): string | null {
  const get = (key: string) => {
    const l = stepBody.find((x) => {
      const kv = splitKey(x.text.replace(/^-\s*/, ""));
      return kv != null && kv.key === key;
    });
    if (!l) return null;
    return unquote(splitKey(l.text.replace(/^-\s*/, ""))!.value);
  };
  const name = get("name");
  if (name) return name;
  const uses = get("uses");
  if (uses) {
    // owner/action@ref → action (last path segment before @)
    const path = uses.split("@")[0];
    return path.split("/").pop() || path;
  }
  const run = get("run");
  if (run) {
    const firstLine = run.split("\n")[0].trim();
    return firstLine.length > 32 ? firstLine.slice(0, 31) + "…" : firstLine;
  }
  return null;
}

function parseSteps(jobBody: Line[]): string[] {
  const stepsLine = jobBody.find((l) => {
    const kv = splitKey(l.text);
    return kv != null && kv.key === "steps";
  });
  if (!stepsLine) return [];
  const block = blockOf(jobBody, jobBody.indexOf(stepsLine) + 1, stepsLine.indent);
  // Each step is a list item: a line starting with `- ` at the shallowest indent.
  const itemIndent = block.find((l) => l.text.startsWith("- "))?.indent;
  if (itemIndent == null) return [];
  const labels: string[] = [];
  for (let i = 0; i < block.length; i++) {
    if (block[i].indent !== itemIndent || !block[i].text.startsWith("- ")) continue;
    // A step's body: this `- ` line plus following lines indented deeper.
    const body: Line[] = [block[i]];
    for (let j = i + 1; j < block.length; j++) {
      if (block[j].indent <= itemIndent) break;
      body.push(block[j]);
    }
    const label = stepLabel(body);
    if (label) labels.push(label);
  }
  return labels;
}

function parseJobs(lines: Line[]): WorkflowJob[] {
  const i = findTop(lines, ["jobs"]);
  if (i < 0) return [];
  const block = blockOf(lines, i + 1, lines[i].indent);
  if (block.length === 0) return [];
  const jobIndent = block[0].indent;
  const jobs: WorkflowJob[] = [];
  for (let j = 0; j < block.length; j++) {
    if (block[j].indent !== jobIndent) continue;
    const kv = splitKey(block[j].text);
    if (!kv || !kv.key) continue;
    const body = blockOf(block, j + 1, block[j].indent);
    const nameLine = body.find((l) => l.indent === (body[0]?.indent ?? 0) && splitKey(l.text)?.key === "name");
    const runsLine = body.find((l) => splitKey(l.text)?.key === "runs-on");
    jobs.push({
      id: kv.key,
      name: nameLine ? unquote(splitKey(nameLine.text)!.value) || null : null,
      runsOn: runsLine ? unquote(splitKey(runsLine.text)!.value) || "—" : "—",
      steps: parseSteps(body),
    });
  }
  return jobs;
}

/**
 * Parse a GitHub Actions workflow file into the `on` / `env` / `jobs` summary the
 * Actions screen renders. Tolerant by design: unrecognized shapes yield empty
 * sections rather than errors.
 */
export function parseWorkflowYaml(yaml: string): ParsedWorkflow {
  const lines = tokenize(yaml);
  return { on: parseOn(lines), env: parseEnv(lines), jobs: parseJobs(lines) };
}
