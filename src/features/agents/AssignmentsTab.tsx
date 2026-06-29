// Agents — Assignments tab (#1643 split from AgentsScreen).
//
// The always-present application sessions + the per-pane console assignments, each
// pane showing its resolved command allowlist (guaranteed ∪ profile ∪ project ∪
// repo). The pane-profile picker (#681) is the click-to-open `ProfileSelect`.

import { useEffect, useState } from "react";
import { GUARANTEED, resolveAllowlistFrom, type AgentProfile, type ConsoleSession } from "./lib/agentProfiles";
import { appSessionTag } from "./lib/appSession";
import { CardListRow } from "@/shared/ui/CardListRow";
import { Chip } from "@/shared/ui/Chip";
import { modeTone } from "./lib/badgeTone";

export interface AssignmentsTabProps {
  roles: AgentProfile[]; consoles: ConsoleSession[]; paneTotal: number;
  /** Assignable profiles (the user/custom profiles a pane can run under). */
  profiles: AgentProfile[];
  /** Assign a specific profile to a pane (#681 — replaces the old cycle-to-next). */
  onAssign: (consoleId: string, paneId: string, profileId: string) => void;
  onOpen: (id: string) => void;
  find: (id: string) => AgentProfile | undefined;
}

/** A click-to-open dropdown for picking a pane's profile (#681). */
export function ProfileSelect({ current, profiles, onPick }: {
  current?: AgentProfile; profiles: AgentProfile[]; onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  return (
    <div className="prof-select" style={{ position: "relative" }} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
      <span className="sw" style={{ background: current?.color }} />
      <span className="nm">{current?.name ?? "—"}</span>
      {current && <Chip tone={modeTone(current.mode)} size="sm" style={{ marginLeft: 2 }}>{current.mode}</Chip>}
      <span className="cv">▾</span>
      {open && (
        <div className="prof-menu" role="listbox" onClick={(e) => e.stopPropagation()}>
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={p.id === current?.id}
              className={"prof-opt" + (p.id === current?.id ? " on" : "")}
              onClick={() => { onPick(p.id); setOpen(false); }}
            >
              <span className="sw" style={{ background: p.color }} />
              <span className="nm">{p.name}</span>
              <Chip tone={modeTone(p.mode)} size="sm">{p.mode}</Chip>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AppSessionRow({ p, onOpen }: { p: AgentProfile; onOpen: (id: string) => void }) {
  const all = [
    ...GUARANTEED.map((c) => ({ cmd: c, origin: "guaranteed" as const })),
    ...p.commands.map((c) => ({ cmd: c, origin: "profile" as const })),
  ];
  return (
    <CardListRow
      variant="grouped"
      lead={<span className="pdot running" />}
      title={appSessionTag(p)}
      subtitle={<span style={{ fontFamily: "var(--mono)" }}>{p.session}</span>}
      titleAside={
        <div className="prof-select" onClick={() => onOpen(p.id)}>
          <span className="sw" style={{ background: p.color }} />
          <span className="nm">{p.name}</span>
          <Chip tone="info" size="xs" style={{ marginLeft: 2 }}>locked</Chip>
        </div>
      }
      body={
        <div className="resolved">
          <span className="lbl">runs:</span>
          {all.map((r) => (
            <span key={r.cmd} className={`rchip ${r.origin === "guaranteed" ? "guar" : ""}`} title={`from ${r.origin}`}>{r.cmd}</span>
          ))}
          <span className="rchip" style={{ borderStyle: "dashed" }}>owns {p.surface}</span>
        </div>
      }
      trailing={<button className="btn ghost" style={{ height: 24, fontSize: 10 }} onClick={() => onOpen(p.id)}>edit role →</button>}
    />
  );
}

export function AssignmentsTab({ roles, consoles, paneTotal, profiles, onAssign, onOpen, find }: AssignmentsTabProps) {
  return (
    <>
      <div className="sec-head">
        <h3>Application sessions</h3>
        <span className="hint">always present · one per workspace · role is fixed</span>
        <div className="spacer" />
        <span className="meta">{roles.length} system roles</span>
      </div>
      <div className="asn-grid" style={{ marginBottom: 14 }}>
        <div className="console-card" style={{ borderColor: "color-mix(in oklch, var(--info), transparent 78%)" }}>
          <div className="ch" style={{ background: "color-mix(in oklch, var(--info), transparent 92%)" }}>
            <span className="cdot" style={{ background: "var(--info)" }} />
            <span className="cn">system</span>
            <span className="repo">workspace-wide</span>
            <span className="spacer" />
            <span className="hint" style={{ fontFamily: "var(--mono)" }}>launched at startup · not reassignable</span>
          </div>
          {roles.map((p) => <AppSessionRow key={p.id} p={p} onOpen={onOpen} />)}
        </div>
      </div>

      <div className="sec-head">
        <h3>Console sessions</h3>
        <span className="hint">each pane runs under one profile · the resolved command allowlist shows what actually runs there</span>
        <div className="spacer" />
        <span className="meta">{consoles.length} consoles · {paneTotal} panes</span>
      </div>
      <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
        <div className="asn-grid">
          {consoles.map((c) => (
            <div className="console-card" key={c.id}>
              <div className="ch">
                <span className="cdot" />
                <span className="cn">{c.name}</span>
                <span className="repo">{c.repo}</span>
                <span className="spacer" />
                <span className="hint" style={{ fontFamily: "var(--mono)" }}>
                  project allow: {(c.projectAllow || []).join(", ") || "—"}{c.repoAllow ? ` · repo: ${c.repoAllow.join(", ")}` : ""}
                </span>
              </div>
              {c.panes.map((pane) => {
                const p = find(pane.profileId);
                const resolved = resolveAllowlistFrom(c, p);
                return (
                  <CardListRow
                    key={pane.id}
                    variant="grouped"
                    lead={<span className={`pdot ${pane.status}`} />}
                    title={pane.agent}
                    subtitle={<span style={{ fontFamily: "var(--mono)" }}>{pane.id}</span>}
                    titleAside={<ProfileSelect current={p} profiles={profiles} onPick={(id) => onAssign(c.id, pane.id, id)} />}
                    body={
                      <div className="resolved">
                        <span className="lbl">runs:</span>
                        {resolved.map((r) => (
                          <span key={r.cmd} className={`rchip ${r.origin === "guaranteed" ? "guar" : ""}`} title={`from ${r.origin}`}>{r.cmd}</span>
                        ))}
                        {resolved.length === 0 && <span className="rchip">— prompt for everything —</span>}
                      </div>
                    }
                    trailing={<button className="btn ghost" style={{ height: 24, fontSize: 10 }} onClick={() => onOpen(pane.profileId)}>edit profile →</button>}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
