// Pure helpers for the planner's section-by-section discovery loop.
//
// Free of React / xterm / Tauri imports so the tag parsing and message building
// can be unit-tested in isolation and shared with Planning.tsx.

// Quote-flexible class: straight ("), and curly (“ ”) so an LLM emitting smart
// quotes doesn't silently break tag detection. Mirrors the other planner tags.
const Q = '["“”]';

const PLAN_FOCUS_RE = () => new RegExp(`<plan_focus\\s+section=${Q}(\\w+)${Q}\\s*\\/>`, "g");

/**
 * Extract the section keys from every `<plan_focus section="key" />` tag in a
 * chunk of (ANSI-stripped) terminal output, in order of appearance. Returns []
 * when none are present.
 */
export function parsePlanFocus(text: string): string[] {
  const re = PLAN_FOCUS_RE();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/** Remove every `<plan_focus>` tag from the buffer so it never prints in the terminal. */
export function stripPlanFocus(text: string): string {
  return text.replace(PLAN_FOCUS_RE(), "");
}

/**
 * The message injected into Claude's PTY when the user confirms a section in the
 * UI. It is the "advance to the next section" signal for the discovery loop.
 */
export function buildSectionConfirmMessage(sectionTitle: string): string {
  return `[The user confirmed the "${sectionTitle}" section in the planner UI — continue to the next section.]`;
}
