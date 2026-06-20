// Parse the planner's <ui_preview screen="..." mode="2d|3d" /> tags from the PTY
// stream (#533) — the trigger that renders a generated UI skeleton into the preview
// pane. Quote-flexible (straight + smart quotes) like the other planning tags.

export interface UiPreviewTag { screen: string; mode: "2d" | "3d" }

const Q = '["“”]';
const TAG = `<ui_preview\\s+screen=${Q}([^"“”]+)${Q}(?:\\s+mode=${Q}(2d|3d)${Q})?\\s*\\/>`;

export function parseUiPreviewTags(text: string): UiPreviewTag[] {
  const re = new RegExp(TAG, "g");
  const out: UiPreviewTag[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ screen: m[1].trim(), mode: (m[2] as "2d" | "3d") ?? "2d" });
  }
  return out;
}

export function stripUiPreviewTags(text: string): string {
  return text.replace(new RegExp(TAG, "g"), "");
}
