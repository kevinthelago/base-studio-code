// What clicking a node to EXPAND it should do (#expanding-a-node-resumes-its-session).
//
// The per-node Resume button lived in the right pane, which was retired — so the expand click is now
// the resume. Studio nodes already worked this way (`useStudioViewers` starts a studio when its morph
// opens); this gives the fleet the same rule.
//
// Pure, and separate from GlanceWorkspace, for the reason `directorDrive` and `briefRouting` are: the
// interesting part is a four-way decision with one genuinely non-obvious branch, and testing it through
// a rendered graph would mean standing up a whole drilled fleet to assert a boolean.

/** The one non-obvious input, spelled out because it has misled this codebase repeatedly. */
export interface ExpandInput {
  /** Is this the app's own studio project? Studio nodes own their lifecycle — the morph starts them. */
  isStudioProject: boolean;
  /** For a studio node: does it morph (i.e. has a session) at all? Library/resource nodes do not. */
  studioMorphs?: boolean;
  /** Does a session CELL exist for this pane — i.e. is it a member of an open tab?
   *
   *  NOT "an agent is running". `livePaneIds` is tab membership (`glanceFleet.ts`), and #3998 measured
   *  77 of 78 fleet panes reading as live while sitting at a bare `$` prompt with no agent. Treating
   *  this as "running" is why Resume looked inert for so long. */
  paneIsLive: boolean;
  /** Has this worker finished its owned work? (#4029) */
  paneIsComplete: boolean;
  /** Is the project's build tab still open, so ONE pane can be resumed in place? */
  canResumeInPlace: boolean;
}

export type ExpandAction =
  /** Open the morph; the studio's own lazy start brings the session up. */
  | { kind: "studio-morph" }
  /** No session to open (a library/resource node) — just select it. */
  | { kind: "select" }
  /** A finished worker is not put back on the model by a stray click; say why, do not expand. */
  | { kind: "refuse-complete"; reason: string }
  /** The pane exists but its agent exited — type the resume into the shell it already has. */
  | { kind: "expand-and-restart-agent" }
  /** No pane, but its build tab is open — resume just this one in place. */
  | { kind: "expand-and-resume-pane" }
  /** No pane and no tab — the whole fleet has to come back before this node can. */
  | { kind: "expand-and-resume-fleet" };

export const COMPLETE_REASON =
  "This worker is complete. The director wakes it when it dispatches work.";

/**
 * Decide what an expand click means for one node.
 *
 * Order matters: the COMPLETE check precedes every expansion, so a finished worker cannot be restarted
 * by a click that was only meant to look at it.
 */
export function decideExpand(input: ExpandInput): ExpandAction {
  if (input.isStudioProject) {
    return input.studioMorphs ? { kind: "studio-morph" } : { kind: "select" };
  }
  if (input.paneIsComplete) return { kind: "refuse-complete", reason: COMPLETE_REASON };
  if (input.paneIsLive) return { kind: "expand-and-restart-agent" };
  if (input.canResumeInPlace) return { kind: "expand-and-resume-pane" };
  return { kind: "expand-and-resume-fleet" };
}
