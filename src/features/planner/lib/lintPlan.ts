// Plan gap scanner (#528/#534 → #897). `findPlanGaps` flags empty files / unresolved
// placeholders in a stage's section content. Originally the lint-plan stage module's check; the
// stage engine + its dispatch wrapper were removed in #897 (Phase 4c/cleanup), and the
// placeholder check now lives in the declarative stage gate (Phase 4b — Planning computes a
// `hasPlanGaps` signal from this). Pure; no React/Tauri.

// Deliberate "fill this in later" markers a finished plan section shouldn't contain. Only the
// explicit dev markers — NOT ellipsis ("..."/"…") or the bare word "placeholder", which are normal
// prose and false-positived the gate (#918).
const PLACEHOLDER_RE = /\b(TODO|TBD|FIXME|XXX|TKTK)\b/i;

/** Gaps in a stage's artifacts: empty files or unresolved placeholders. Pure. */
export function findPlanGaps(artifacts: Record<string, string>): string[] {
  const gaps: string[] = [];
  for (const [file, content] of Object.entries(artifacts)) {
    const text = (content ?? "").trim();
    if (!text) gaps.push(`${file}: empty`);
    else if (PLACEHOLDER_RE.test(text)) gaps.push(`${file}: unresolved placeholder`);
  }
  return gaps;
}
