// Parse the planner's <pipeline id="…" cmd="…" …args /> tags from the PTY stream — the
// standardized surface through which Claude drives a stage module (run/save/confirm/restart/
// prev/next/goto/delete). Every attribute other than id/cmd becomes a free-form arg the
// pipeline interprets. Quote-flexible (straight + smart quotes), matching the other
// planning tags. Tags missing id/cmd or carrying an unknown cmd are skipped.
//
// <ui_preview> is a thin alias for <pipeline id="render-preview" cmd="run" …>; the stream
// handler routes both through the same command bus (dispatchStageCommand).

import { isStageCommand, type StageCommand } from "./stageCommands";

export interface StageTag {
  id: string;
  cmd: StageCommand;
  args: Record<string, string>;
}

const Q = '["“”]';
const TAG = `<pipeline\\b([^>]*?)\\/>`;

/** Parse every well-formed <pipeline .../> tag, in stream order. */
export function parseStageTags(text: string): StageTag[] {
  const tagRe = new RegExp(TAG, "g");
  const out: StageTag[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) {
    const attrRe = new RegExp(`([a-zA-Z_][\\w-]*)=${Q}([^"“”]*)${Q}`, "g");
    const attrs: Record<string, string> = {};
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(m[1])) !== null) attrs[a[1]] = a[2];
    const { id, cmd, ...args } = attrs;
    if (!id || !cmd || !isStageCommand(cmd)) continue;
    out.push({ id, cmd, args });
  }
  return out;
}

export function stripStageTags(text: string): string {
  return text.replace(new RegExp(TAG, "g"), "");
}
