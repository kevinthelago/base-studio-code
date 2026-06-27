// "Skills for this session" — Surface B of the Skills redesign (#skills-groups). An overlay that
// chooses which skills ONE session (a console pane, a fleet worker, a triage pane) can invoke,
// over the inherit-then-override model: each row shows its effective state + why (global / pinned /
// project-scoped / group / out-of-scope), and a per-skill toggle layers an add/remove override. A
// "Quick-add a task group" row toggles a whole ⬡ group onto the session at once. Writes the store
// `sessionSkillOverrides` + `sessionSkillGroups` slices; the next session launch resolves them via
// effectiveSessionSkills into `.claude/skills/<slug>/SKILL.md`. Pairs with the planner channel,
// which toggles the same groups onto a stream.
import { useMemo, useState } from "react";
import { useAppStore } from "@/store";
import { Toggle } from "@/shared/ui/Toggle";
import { IconButton } from "@/shared/ui/IconButton";
import { KIND, SOURCE_TAG } from "@/shared/data/skills";
import { pill, sourcePill } from "./skillStyles";
import {
  sessionSkillState, expandGroups, groupSkillCount,
  type SkillDef, type SessionSkillReason,
} from "./lib/skills";
import "./skills.css";

/** Color + copy for each effective-state reason (the row's "why" pill). */
const REASON_META: Record<SessionSkillReason, { label: string; hue: string; hint: string }> = {
  global:        { label: "on · global",        hue: "var(--success)", hint: "" },
  project:       { label: "on · project-scoped", hue: "var(--info)",    hint: "" },
  pinned:        { label: "on · pinned",         hue: "var(--success)", hint: "auto-offered to the fleet" },
  group:         { label: "on · group",          hue: "var(--violet)",  hint: "enabled by a task group" },
  added:         { label: "added",               hue: "var(--accent)",  hint: "override · normally out of scope" },
  removed:       { label: "removed",             hue: "var(--danger)",  hint: "override · normally on" },
  "out-of-scope":{ label: "off · out of scope",  hue: "var(--fg-dim)",  hint: "" },
  disabled:      { label: "off · disabled",      hue: "var(--fg-dim)",  hint: "disabled in the library" },
};

function glyphTile(kind: SkillDef["kind"]): React.CSSProperties {
  const c = KIND[kind].color;
  return { width: 24, height: 24, flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, fontFamily: "var(--mono)", fontSize: 12, color: c, background: `color-mix(in oklch, ${c} 22%, var(--bg-elev))`, border: `1px solid color-mix(in oklch, ${c}, transparent 70%)` };
}

export interface SessionSkillsModalProps {
  /** The session's STABLE identity id (the paneSkills/override key). */
  sessionKey: string;
  /** The session's project (for scope resolution). "" for an ad-hoc console. */
  projectId: string;
  /** A short human label for the session, e.g. "worker · payments-api · stream:checkout". */
  sessionLabel?: string;
  onClose: () => void;
}

export function SessionSkillsModal({ sessionKey, projectId, sessionLabel, onClose }: SessionSkillsModalProps) {
  const skills = useAppStore((s) => s.skills);
  const skillGroups = useAppStore((s) => s.skillGroups);
  const override = useAppStore((s) => s.sessionSkillOverrides[sessionKey]);
  const sessionGroups = useAppStore((s) => s.sessionSkillGroups[sessionKey]);
  const setSessionSkill = useAppStore((s) => s.setSessionSkill);
  const setSessionSkillGroup = useAppStore((s) => s.setSessionSkillGroup);
  const resetSessionSkills = useAppStore((s) => s.resetSessionSkills);

  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"assigned" | "all">("assigned");

  const groupIds = sessionGroups ?? [];
  const groupSkillIds = useMemo(() => new Set(expandGroups(groupIds, skillGroups)), [groupIds, skillGroups]);

  const states = useMemo(
    () => skills.map((s) => sessionSkillState(s, projectId, override, groupSkillIds)),
    [skills, projectId, override, groupSkillIds],
  );
  const availCount = states.filter((st) => st.on).length;
  const overrides = states.filter((st) => st.overridden);

  const q = query.trim().toLowerCase();
  const matches = (st: { skill: SkillDef }) => !q || (st.skill.name + " " + st.skill.desc + " " + st.skill.tools.join(" ")).toLowerCase().includes(q);
  const overrideRows = overrides.filter(matches);
  const restRows = states.filter((st) => !st.overridden && (tab === "all" || st.on)).filter(matches);

  // Toggling a row: on->off writes a remove override, off->on writes an add; either way the next
  // setSessionSkill clears the opposite. (A skill that's on purely via inheritance/group flips to a
  // remove override; one that's off flips to an add.)
  const flip = (st: { skill: SkillDef; on: boolean }) => setSessionSkill(sessionKey, st.skill.id, st.on ? "off" : "on");

  function Row({ st }: { st: ReturnType<typeof sessionSkillState> }) {
    const m = REASON_META[st.reason];
    return (
      <div className="sess-skill-row" data-skill-id={st.skill.id} style={{ display: "grid", gridTemplateColumns: "24px 1fr auto", alignItems: "center", gap: 12, padding: "9px 20px", borderBottom: "1px solid var(--border-soft)",
        background: st.overridden ? "color-mix(in oklch, var(--accent), transparent 93%)" : "transparent",
        boxShadow: st.overridden ? (st.reason === "removed" ? "inset 2px 0 0 var(--danger)" : "inset 2px 0 0 var(--accent)") : "none" }}>
        <span style={glyphTile(st.skill.kind)}>{KIND[st.skill.kind].glyph}</span>
        <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{st.skill.name}</span>
            <span style={sourcePill(st.skill.source)}>{SOURCE_TAG[st.skill.source].label}</span>
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={pill(m.hue, m.hue === "var(--fg-dim)")}>{m.label}</span>
            {m.hint && <span style={{ fontSize: 10.5, color: "var(--fg-dim)" }}>{m.hint}</span>}
          </span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {st.overridden && <span onClick={() => setSessionSkill(sessionKey, st.skill.id, "inherit")} style={{ fontSize: 10.5, color: "var(--fg-dim)", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2 }}>reset</span>}
          <Toggle size="sm" className="sess-toggle" on={st.on} onClick={() => flip(st)} />
        </span>
      </div>
    );
  }

  return (
    <div className="modal-scrim start" onClick={onClose} style={{ padding: "34px 20px", overflow: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 840, maxWidth: "100%", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", boxShadow: "0 24px 70px rgba(0,0,0,.5)", display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 120px)", overflow: "hidden" }}>
        {/* header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-soft)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg)" }}>Skills for this session</div>
            <span style={{ flex: 1 }} />
            <IconButton aria-label="close" onClick={onClose} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-muted)" }}>{sessionLabel || sessionKey}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11.5, color: "var(--fg-muted)" }}><b style={{ fontFamily: "var(--mono)", color: "var(--fg)" }}>{availCount}</b> available · <b style={{ fontFamily: "var(--mono)", color: "var(--accent)" }}>{overrides.length}</b> overrides</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 13 }}>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, height: 30, padding: "0 11px", background: "var(--bg-canvas)", border: "1px solid var(--border)", borderRadius: "var(--r-md)" }}>
              <span style={{ color: "var(--fg-dim)", fontSize: 13 }}>⌕</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search skills…" style={{ flex: 1, background: "none", border: "none", outline: "none", color: "var(--fg)", fontSize: 12.5 }} />
            </div>
            <div style={{ display: "flex", height: 30, border: "1px solid var(--border)", borderRadius: "var(--r-md)", overflow: "hidden" }}>
              {([["assigned", `Assigned (${availCount})`], ["all", `All (${skills.length})`]] as const).map(([t, lbl], i) => (
                <div key={t} onClick={() => setTab(t)} style={{ display: "flex", alignItems: "center", padding: "0 11px", fontSize: 11, cursor: "pointer", background: tab === t ? "var(--bg-elev2)" : "transparent", color: tab === t ? "var(--fg)" : "var(--fg-dim)", borderRight: i === 0 ? "1px solid var(--border)" : "none" }}>{lbl}</div>
              ))}
            </div>
            <button onClick={() => resetSessionSkills(sessionKey)} style={{ height: 30, padding: "0 11px", borderRadius: "var(--r-md)", border: "1px solid var(--border)", background: "var(--bg-elev)", color: "var(--fg-muted)", fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" }}>↺ Reset all</button>
          </div>
          {/* quick-add a task group */}
          {skillGroups.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 11, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--fg-dim)" }}>⬡ Quick-add a task group</span>
              {skillGroups.map((g) => { const on = groupIds.includes(g.id); return (
                <button key={g.id} onClick={() => setSessionSkillGroup(sessionKey, g.id, !on)} style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 24, padding: "0 10px", borderRadius: 99, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap", border: "1px solid " + (on ? g.hue : "var(--border)"), background: on ? `color-mix(in oklch, ${g.hue}, transparent 85%)` : "transparent", color: on ? g.hue : "var(--fg-muted)" }}>
                  <span style={{ opacity: 0.75 }}>⬡</span>{g.name}<span style={{ fontFamily: "var(--mono)", fontSize: 9.5, opacity: 0.7 }}>{on ? "✓" : "+" + groupSkillCount(g, skills)}</span>
                </button>
              ); })}
            </div>
          )}
        </div>

        {/* list */}
        <div style={{ flex: 1, overflowY: "auto", paddingTop: 6 }}>
          {overrideRows.length > 0 && (
            <>
              <div style={{ padding: "9px 20px 5px 20px", fontFamily: "var(--mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--accent)" }}>Overrides · {overrideRows.length}</div>
              {overrideRows.map((st) => <Row key={st.skill.id} st={st} />)}
            </>
          )}
          <div style={{ padding: "13px 20px 5px 20px", fontFamily: "var(--mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--fg-dim)" }}>
            {tab === "assigned" ? `Assigned to this session · ${restRows.length}` : `All skills · ${restRows.length}`}
          </div>
          {restRows.map((st) => <Row key={st.skill.id} st={st} />)}
          {restRows.length === 0 && overrideRows.length === 0 && (
            <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--fg-dim)", fontSize: 12 }}>No skills match.</div>
          )}
        </div>

        {/* footer */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", borderTop: "1px solid var(--border-soft)", background: "var(--bg-canvas)" }}>
          <span style={{ fontSize: 11, color: "var(--fg-dim)", lineHeight: 1.4 }}>Written as <span style={{ fontFamily: "var(--mono)", color: "var(--fg-muted)" }}>.claude/skills/&lt;slug&gt;/SKILL.md</span> on next relaunch.</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={{ height: 31, padding: "0 16px", borderRadius: "var(--r-md)", border: "1px solid var(--accent-dim)", background: "var(--accent)", color: "var(--bg-canvas)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Done</button>
        </div>
      </div>
    </div>
  );
}
