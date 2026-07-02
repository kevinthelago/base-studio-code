// projectPaneContext -- maps the project's plan section files into the ProjectPane
// `ContextFile` cards (kind, token size, pinned state). Extracted from
// projectPaneData (#2151); pure, no logic changes.

import type { ContextFile } from "./projectPane.types";
import type { BuildProjectPaneInput } from "./projectPaneInput";

export function buildContext(input: BuildProjectPaneInput): ContextFile[] {
  // When the project has an explicit pinned set (user toggles in the pane),
  // it drives `pinned`; otherwise fall back to the confirmed-section default.
  const explicitPins = input.pinned ? new Set(input.pinned) : undefined;
  // Skip empty section files — a created-but-unwritten section would otherwise show as a
  // ghost 0.0k context file (#654). Also skip the deprecated `issues` / `issues-phase<n>`
  // sections: issues are no longer an authored plan file — they're generated from the feature
  // DAG at GitHub-publish time (#plan-db), so a stale (often near-empty) issues section must
  // not resurface as a ghost context card.
  return input.sections.filter(s =>
    s.content.trim().length > 0 && s.k !== "issues" && !s.k.startsWith("issues-phase"),
  ).map(s => {
    const kind = s.k === "claude" ? "claude"
      : s.k.includes("spec") ? "spec"
      : "doc";
    const tok = (s.content.length / 1000).toFixed(1) + "k";
    // The displayed filename is the canonical KEY (+ .md) so it matches the on-disk file
    // (`stack.md`), not the human title ("Tech stack.md") which would mislead (#803). The
    // global project guidance file is the uppercase `CLAUDE.md` on disk.
    const name = s.k === "claude" ? "CLAUDE.md" : s.k + ".md";
    return {
      name,
      kind,
      tok,
      pinned: explicitPins ? explicitPins.has(name) : s.state === "confirmed",
      scope: "project",
      content: s.content,
    };
  });
}
