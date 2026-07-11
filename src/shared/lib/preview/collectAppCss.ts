// collectAppCss (#2824) — serialize the app's live stylesheets (design tokens + component CSS) into one
// string so it can be injected into the preview iframe, which renders in its OWN document and otherwise
// has none of the app's styles. This is what makes a built-in kit component render THEMED in the iframe
// (its own `.css` imports are no-op'd during bundling — see componentBundle). Browser-only; same-origin
// sheets only (reading `cssRules` on a cross-origin sheet throws — those are skipped).
export function collectAppCss(): string {
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules; // SecurityError for a cross-origin sheet — skip it
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) out.push(rule.cssText);
  }
  return out.join("\n");
}
