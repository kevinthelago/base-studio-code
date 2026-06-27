// usePlannerTagStream (#1474) — the planner's PTY tag-parse stream, extracted verbatim from
// Planning.tsx. Owns the two output buffers and a `processChunk` that, per PTY data chunk:
// strips ANSI, accumulates, parses + dispatches every structured `<tag>` the planner emits, and
// caps the buffer. The terminal write itself stays in the caller; this hook is the tag side only.
//
//   bufRef         — the tag-scan buffer (drained by the parsers as tags are consumed)
//   autopilotTxRef — an UN-consumed copy of the same output, read by the autopilot idle-detector
//
// Both refs are returned so the caller's restart (clears bufRef) and autopilot (reads
// autopilotTxRef) keep their existing access. `processChunk` is a stable callback that reads its
// live deps through a ref, so the once-attached `pty_data` listener never captures a stale value.

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { useAppStore } from "@/store";
import { sanitizeProjectKey } from "@/shared/lib/core/projectPaths";
import { stripAnsi } from "./planningTerminal";
import { parseDataModelTag, stripDataModelTags } from "./planningParse";
import {
  parsePlanFocus, stripPlanFocus,
  parseStartupScripts, stripStartupScripts, scriptDocRelpath,
  parseAgentAssigns, stripAgentAssigns, parseFleetPlan, stripFleetPlan,
} from "./planningSession";

interface TagStreamDeps {
  projectId: string;
  setActiveSection: (key: string) => void;
  setRepoLinkFullNames: Dispatch<SetStateAction<string[]>>;
}

export interface PlannerTagStream {
  /** Feed one PTY data chunk: accumulate it and parse/dispatch any structured tags it completes. */
  processChunk: (payload: string) => void;
  /** The tag-scan buffer (the caller's restart clears it). */
  bufRef: React.MutableRefObject<string>;
  /** The un-consumed output copy the autopilot idle-detector reads. */
  autopilotTxRef: React.MutableRefObject<string>;
}

export function usePlannerTagStream(deps: TagStreamDeps): PlannerTagStream {
  // Accumulated stripped output used to scan for complete tags.
  const bufRef = useRef("");
  // Autopilot (#746): an un-consumed copy of the planner's raw output (bufRef is drained by
  // the tag parsers), for idle-detection + the user-sim.
  const autopilotTxRef = useRef("");

  // Keep the live deps in a ref so `processChunk` stays a stable identity (the listener is
  // attached once) while never reading a stale projectId/setter. Updated post-commit; the
  // listener only fires after mount, so the ref is always current by the first chunk.
  const depsRef = useRef(deps);
  useEffect(() => { depsRef.current = deps; });

  const processChunk = useCallback((payload: string) => {
    const { projectId: projIdSnap, setActiveSection, setRepoLinkFullNames } = depsRef.current;

    // Parse structured tags out of the stripped output stream.
    bufRef.current += stripAnsi(payload);
    autopilotTxRef.current += stripAnsi(payload); // un-consumed copy for the autopilot (#746)

    // Quote-flexible helper: matches " U+0022, " U+201C, " U+201D so LLM
    // smart-quote output doesn't silently break tag detection.
    // q(s) wraps a string in a char-class that matches any of those three.
    const Q = '["“”]';

    let m: RegExpExecArray | null;

    // Discovery/context section CONTENT now lives in `context/<topic>.md` files the planner
    // writes (read by the section poll + by workers) — the single channel (#1019). The redundant
    // `<plan_update section>` stream tag is retired; its required-set + confirm state moved to the
    // plan.db context manifest (`bsc-plan context` + the manifest poll above).

    // ── <plan_focus section="key" /> ─────────────────────────────────────
    // Marks the section Claude is currently discussing. The last focus tag
    // in this chunk wins (Claude emits one per section as it advances). Any
    // key is accepted — the focused section may not exist as a card yet.
    const focusKeys = parsePlanFocus(bufRef.current);
    if (focusKeys.length > 0) {
      setActiveSection(focusKeys[focusKeys.length - 1]);
      bufRef.current = stripPlanFocus(bufRef.current);
    }

    // ── <repo_link full_name="owner/repo" /> ─────────────────────────────
    const repoLinkRe = new RegExp(
      `<repo_link\\s+full_name=${Q}([^\\u0022\\u201c\\u201d]+)${Q}\\s*\\/>`,'g'
    );
    let foundLink = false;
    while ((m = repoLinkRe.exec(bufRef.current)) !== null) {
      const fullName = m[1];
      setRepoLinkFullNames(prev =>
        prev.includes(fullName) ? prev : [...prev, fullName]
      );
      // The headless auto-clone effect clones repos as repoLinkFullNames grows — no action needed here.
      foundLink = true;
    }
    if (foundLink) {
      bufRef.current = bufRef.current.replace(
        new RegExp(`<repo_link\\s+full_name=${Q}[^\\u0022\\u201c\\u201d]+${Q}\\s*\\/>`, 'g'),
        ""
      );
    }

    // ── <automation_assign name="..." command="..." … /> ──────────────────
    const autoAssignRe = /<automation_assign([^/]*)\s*\/>/g;
    let foundAuto = false;
    while ((m = autoAssignRe.exec(bufRef.current)) !== null) {
      const attrs  = m[1];
      // Each attr value may use straight or curly quotes
      const attrRe = (k: string) => new RegExp(`\\b${k}=${Q}([^\\u0022\\u201c\\u201d]*)${Q}`);
      const nameM  = attrRe("name").exec(attrs);
      const cmdM   = attrRe("command").exec(attrs);
      const schedM = attrRe("schedule").exec(attrs);
      const descM  = attrRe("description").exec(attrs);
      if (nameM && cmdM) {
        useAppStore.getState().addPlanAutomation(projIdSnap, {
          name:        nameM[1],
          command:     cmdM[1],
          schedule:    schedM?.[1],
          description: descM?.[1],
        });
      }
      foundAuto = true;
    }
    if (foundAuto) {
      bufRef.current = bufRef.current.replace(/<automation_assign[^/]*\/>/g, "");
    }

    // ── <startup_script repo="owner/repo" mode="dev|triage" path="..." /> ──
    // Registers a per-repo starting script the planner wrote to prompts/.
    // The path is relative to the project dir; resolve it to a unified-store
    // relpath and auto-assign so opening that repo's console (dev) or triage
    // pane uses it. projectId = the planning session key (matches what the
    // board passes to quick start / triage for existing projects).
    const scripts = parseStartupScripts(bufRef.current);
    if (scripts.length > 0) {
      const key = sanitizeProjectKey(projIdSnap);
      const store = useAppStore.getState();
      for (const sc of scripts) {
        const relpath = scriptDocRelpath(key, sc.path);
        if (sc.mode === "triage") store.setRepoTriagePromptDoc(projIdSnap, sc.repo, relpath);
        else                      store.setRepoStartupPromptDoc(projIdSnap, sc.repo, relpath);
      }
      bufRef.current = stripStartupScripts(bufRef.current);
    }

    // <allow_command> retired (#1457): command auto-approval is a per-agent profile property
    // now, not a planner-declared project/repo allowlist.

    // ── <fleet_plan recommended="N" reasoning="…" director="true" … /> ─────
    // The fleet-level header: optimal concurrent session count + reasoning +
    // whether a director session is recommended. fleet.json is authoritative;
    // this is the fast path for immediate display before the next poll.
    const fleetMeta = parseFleetPlan(bufRef.current);
    if (fleetMeta) {
      const store = useAppStore.getState();
      store.setPlanFleetMeta(projIdSnap, fleetMeta.recommended, fleetMeta.reasoning, fleetMeta.strategy); // #C
      store.setPlanDirector(projIdSnap, fleetMeta.director, fleetMeta.directorRole);
      bufRef.current = stripFleetPlan(bufRef.current);
    }

    // ── <agent_assign id="…" repo="…" owns="…" issues="…" … /> ────────────
    // One per work stream. Merged by id so a re-emitted tag refines in place.
    const agentStreams = parseAgentAssigns(bufRef.current);
    if (agentStreams.length > 0) {
      const store = useAppStore.getState();
      for (const st of agentStreams) store.addPlanAgentStream(projIdSnap, st);
      bufRef.current = stripAgentAssigns(bufRef.current);
    }

    // MCP assignments moved to plan.db (#1021) — the planner now records them with `bsc-plan mcp
    // add`, and the DB poll below resolves each into the MCP-servers store. (Was a <mcp_assign> tag.)

    // Authored blueprint moved to plan.db (#1022) — the planner now records it with `bsc-plan
    // blueprint set`, and the DB poll below coerces it into the authored blueprint + pins the
    // authoring binding. (Was a <blueprint> stream tag + a blueprint.json file.)

    // Deploy config moved to plan.db (#1020) — the planner now records it with `bsc-plan deploy
    // set`, and the DB poll below coerces it into planDeployConfig. (Was a <deploy_config> tag.)

    // ── <data_model>{"name":"...","entities":[...]}</data_model> ──────────
    // Persists the planner's inferred Data Model to the project's DuckDB store (#1446)
    // hub (#se-persist). `refined` starts false; the source pane sets it to true
    // once the user confirms/refines the model interactively.
    const dm = parseDataModelTag(bufRef.current);
    if (dm) {
      fireInvoke("data_persist_model", {
        projectKey: projIdSnap,
        model: dm,
        refined: false,
      }, (e: unknown) => console.warn("data_persist_model failed:", e));
      bufRef.current = stripDataModelTags(bufRef.current);
    }

    // Cap buffer to prevent unbounded growth while preserving any partial
    // in-progress tag that hasn't received its closing counterpart yet.
    const MAX_BUF = 120_000;
    if (bufRef.current.length > MAX_BUF) {
      const lastTagStart = bufRef.current.lastIndexOf("<");
      bufRef.current = bufRef.current.slice(
        lastTagStart > 0 && lastTagStart > bufRef.current.length - MAX_BUF
          ? lastTagStart
          : bufRef.current.length - MAX_BUF
      );
    }
  }, []);

  return { processChunk, bufRef, autopilotTxRef };
}
