// "Design with Claude" assistant drawer (#609 slice 6) — ported from the design's
// assistant.jsx. A side drawer chat: describe a change, the assistant proposes concrete
// stage actions (via blueprintAssistant), you Apply them to the blueprint. v1 prose is
// the deterministic heuristic; wiring it to the real Claude API is a follow-up.

import { useEffect, useRef, useState } from "react";
import "../../styles/blueprints.css";
import { Ic } from "./blueprintIcons";
import { tint, hue } from "./blueprintCatalog";
import { type BlueprintSection } from "./blueprints";
import {
  planActions, applyAssistantActions, actionLine, proseFor, explainActions, ASSISTANT_SUGGESTIONS,
  isCreateSkillRequest, isAttachSkillRequest, inferSkillKind, authorSkill,
  type AssistantAction,
} from "./blueprintAssistantCore";
import { type BlueprintSkillItem } from "./blueprintSkills";
import { useAppStore } from "../../store";
import { oneShotComplete } from "../../lib/claudeComplete";

interface Msg { who: "me" | "ai"; text: string; actions?: AssistantAction[] | null; applied?: boolean }

export interface BlueprintAssistantProps {
  /** Current sections (proposals + applies are computed against these). */
  sections: BlueprintSection[];
  /** Name of the blueprint being designed (greeting). */
  name: string;
  /** When set, this is a fresh "design from scratch" session (different greeting). */
  draftName?: string;
  /** Persist the assistant's applied changes. */
  onApply: (sections: BlueprintSection[]) => void;
  /** The skills/knowledge library (for attach intents). (#636) */
  library?: BlueprintSkillItem[];
  /** Create a library skill from authored content, returning its new id. (#636) */
  onCreateSkill?: (name: string, content: string) => string;
  onClose: () => void;
  onToast?: (text: string) => void;
}

export function BlueprintAssistant({ sections, name, draftName, onApply, library = [], onCreateSkill, onClose, onToast }: BlueprintAssistantProps) {
  const [msgs, setMsgs] = useState<Msg[]>(() => [
    draftName
      ? { who: "ai", text: `Let's design "${draftName}". Tell me what you're building — the stack, the surface area, how much process you want — and I'll draft the stage flow. Or pick a starting point below.` }
      : { who: "ai", text: `I can reshape "${name}" for you. Describe a concern to add, ask me to gate a stage, or trim it to an MVP — I'll propose changes you can apply.` },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const apiKey = useAppStore((s) => s.claudeApiKey);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [msgs, busy]);

  async function send(text?: string) {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setInput("");
    setMsgs((m) => [...m, { who: "me", text: q }]);
    setBusy(true);

    // Skill intents (#636 slice c): author a new skill (Claude-drafted) or attach an
    // existing library skill, targeting the section named in the request (else the first).
    const kind = inferSkillKind(q, sections);
    if (kind && onCreateSkill && isCreateSkillRequest(q)) {
      const { name: skName, content } = await authorSkill(q, (p) => oneShotComplete(apiKey, p.system, p.user));
      const act: AssistantAction = { op: "create-skill", kind, name: skName, content };
      setMsgs((m) => [...m, { who: "ai", text: `Drafted a skill, "${skName}", for the ${kind} stage. Review and apply to add it to your library + attach it.`, actions: [act] }]);
      setBusy(false);
      return;
    }
    if (kind && isAttachSkillRequest(q)) {
      const lc = q.toLowerCase();
      const item = library.find((i) => lc.includes(i.name.toLowerCase()));
      if (item) {
        const act: AssistantAction = { op: "attach-skill", kind, skillId: item.id, skillName: item.name };
        setMsgs((m) => [...m, { who: "ai", text: `Attach "${item.name}" to the ${kind} stage?`, actions: [act] }]);
        setBusy(false);
        return;
      }
    }

    const actions = planActions(q, sections);
    // Actions stay deterministic; with an API key, Claude writes the explanation prose
    // (falling back to the heuristic summary on any error / no key).
    let prose = proseFor(actions);
    if (apiKey && actions.length) {
      try { prose = await explainActions(actions, name, (p) => oneShotComplete(apiKey, p.system, p.user)); }
      catch { /* keep heuristic prose */ }
    } else {
      await new Promise((r) => setTimeout(r, 300)); // typing feel for the instant heuristic path
    }
    setMsgs((m) => [...m, { who: "ai", text: prose, actions: actions.length ? actions : null }]);
    setBusy(false);
  }

  function apply(actions: AssistantAction[], idx: number) {
    // Materialize create-skill: write the authored skill to the library, then attach it.
    const materialized = actions.map((a): AssistantAction =>
      a.op === "create-skill" && onCreateSkill
        ? { op: "attach-skill", kind: a.kind, skillId: onCreateSkill(a.name, a.content), skillName: a.name }
        : a,
    );
    onApply(applyAssistantActions(sections, materialized));
    setMsgs((m) => m.map((mm, i) => (i === idx ? { ...mm, applied: true } : mm)));
    onToast?.(`Applied ${actions.length} change${actions.length > 1 ? "s" : ""}`);
  }

  return (
    <div className="bp-page" style={{ position: "fixed", inset: 0, zIndex: 55, pointerEvents: "none" }}>
      <div className="drawer" style={{ pointerEvents: "auto" }}>
        <div className="drawer-head">
          <span className="da">✦</span>
          <div><h2>Design with Claude</h2><div className="dsub mono">blueprint architect · session</div></div>
          <span style={{ flex: 1 }} />
          <button className="iconbtn" onClick={onClose}>✕</button>
        </div>

        <div className="drawer-body" ref={bodyRef}>
          {msgs.map((m, i) => (
            <div className={"msg " + (m.who === "me" ? "me" : "ai")} key={i}>
              <span className="who">{m.who === "me" ? "you" : "claude"}</span>
              <div className="bub">{m.text}</div>
              {m.actions && (
                <div className="proposal">
                  <div className="ptitle">✦ Proposed changes <span className="dim">· {m.actions.length}</span></div>
                  <div className="pchanges">
                    {m.actions.map((a, j) => {
                      const l = actionLine(a);
                      return (
                        <div className={"diff-line " + l.type} key={j}>
                          <span className="dmark">{l.type === "add" ? "+" : l.type === "del" ? "−" : "~"}</span>
                          <span style={{ width: 18, height: 18, flex: "0 0 18px", borderRadius: 4, fontSize: 9, background: tint(l.h, 0.18), color: hue(l.h), display: "flex", alignItems: "center", justifyContent: "center" }}><Ic n={l.glyph} size={11} /></span>
                          <span className="dtitle">{l.title}</span>
                          <span style={{ flex: 1 }} />
                          <span className="dim" style={{ fontSize: 9.5 }}>{l.note}</span>
                        </div>
                      );
                    })}
                  </div>
                  {m.applied
                    ? <div className="hint mono" style={{ color: "var(--success)" }}>✓ Applied to blueprint</div>
                    : <div className="pacts">
                        <button className="btn sm primary" onClick={() => apply(m.actions!, i)}>Apply changes</button>
                        <button className="btn sm ghost" onClick={() => setMsgs((mm) => mm.map((x, k) => (k === i ? { ...x, actions: null, text: x.text + " (dismissed)" } : x)))}>Dismiss</button>
                      </div>}
                </div>
              )}
            </div>
          ))}
          {busy && <div className="msg ai"><span className="who">claude</span><div className="bub"><span className="typing"><i /><i /><i /></span></div></div>}
        </div>

        <div className="drawer-foot">
          <div className="chips" style={{ marginBottom: 10 }}>
            {ASSISTANT_SUGGESTIONS.map((s) => <button className="chip-sug" key={s} onClick={() => void send(s)} disabled={busy}>{s}</button>)}
          </div>
          <div className="composer">
            <textarea className="input" placeholder="Describe the change you want…" value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
            <button className="btn primary icon" style={{ height: 56, width: 40 }} onClick={() => void send()} disabled={busy || !input.trim()}>↑</button>
          </div>
        </div>
      </div>
    </div>
  );
}
