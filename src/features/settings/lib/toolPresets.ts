// Tool permission presets + the common-tool suggestion list for the Claude Config editor (#1709).
// Kept as typed TS data (NOT JSON, per project decision) so the shapes stay type-checked and the
// preset table reads as code alongside its consumers.

/** A one-click allow/deny pair applied to the tool-permission editor. */
export interface ToolPreset {
  label: string;
  allow: string[];
  deny: string[];
}

export const TOOL_PRESETS: ToolPreset[] = [
  { label: "read-only",  allow: ["Read", "Glob", "Grep"],                        deny: ["Write", "Edit", "MultiEdit", "Bash", "WebFetch", "WebSearch"] },
  { label: "no-bash",    allow: [],                                               deny: ["Bash"] },
  { label: "no-web",     allow: [],                                               deny: ["WebFetch", "WebSearch"] },
  { label: "full",       allow: [],                                               deny: [] },
];

/** Suggestions surfaced in the chip-input datalist when typing a tool name. */
export const COMMON_TOOLS = ["Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"];
