// Agents — Assignments tab (#1643 split from AgentsWorkspace).
//
// The always-present application sessions + the per-pane console assignments, each
// pane showing its resolved command allowlist (guaranteed ∪ profile ∪ project ∪
// repo). The pane-profile picker (#681) is the click-to-open `ProfileSelect`.

import { useEffect, useState } from "react";
import { GUARANTEED, resolveAllowlistFrom, type AgentProfile, type ConsoleSession } from "./lib/agentProfiles";
import { appSessionTag } from "./lib/appSession";
import { CardListRow } from "@/shared/ui/data/CardListRow";
import { Chip } from "@/shared/ui/data/Chip";
import { SectionHeader } from "@/shared/ui/layout/SectionHeader";
import { Button } from "@/shared/ui/controls/Button";
import { Box } from "@/shared/ui/layout/Box";
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
    <Box className="prof-select" style={{ position: "relative" }} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
      <Box as="span" className="sw" bg={current?.color} />
      <Box as="span" className="nm">{current?.name ?? "—"}</Box>
      {current && <Chip tone={modeTone(current.mode)} size="sm" style={{ marginLeft: 2 }}>{current.mode}</Chip>}
      <Box as="span" className="cv">▾</Box>
      {open && (
        <Box className="prof-menu" role="listbox" onClick={(e) => e.stopPropagation()}>
          {profiles.map((p) => (
            // eslint-disable-next-line no-restricted-syntax -- bespoke listbox option (role=option, .prof-opt styling), not a .btn
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={p.id === current?.id}
              className={"prof-opt" + (p.id === current?.id ? " on" : "")}
              onClick={() => { onPick(p.id); setOpen(false); }}
            >
              <Box as="span" className="sw" bg={p.color} />
              <Box as="span" className="nm">{p.name}</Box>
              <Chip tone={modeTone(p.mode)} size="sm">{p.mode}</Chip>
            </button>
          ))}
        </Box>
      )}
    </Box>
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
      lead={<Box as="span" className="pdot running" />}
      title={appSessionTag(p)}
      subtitle={<Box as="span" className="mono">{p.session}</Box>}
      titleAside={
        <Box className="prof-select" onClick={() => onOpen(p.id)}>
          <Box as="span" className="sw" bg={p.color} />
          <Box as="span" className="nm">{p.name}</Box>
          <Chip tone="info" size="xs" style={{ marginLeft: 2 }}>locked</Chip>
        </Box>
      }
      body={
        <Box className="resolved">
          <Box as="span" className="lbl">runs:</Box>
          {all.map((r) => (
            <Box as="span" key={r.cmd} className={`rchip ${r.origin === "guaranteed" ? "guar" : ""}`} title={`from ${r.origin}`}>{r.cmd}</Box>
          ))}
          <Box as="span" className="rchip" style={{ borderStyle: "dashed" }}>owns {p.surface}</Box>
        </Box>
      }
      trailing={<Button variant="ghost" style={{ height: 24, fontSize: 10 }} onClick={() => onOpen(p.id)}>edit role →</Button>}
    />
  );
}

export function AssignmentsTab({ roles, consoles, paneTotal, profiles, onAssign, onOpen, find }: AssignmentsTabProps) {
  return (
    <>
      <SectionHeader title="Application sessions" hint="always present · one per workspace · role is fixed" meta={<>{roles.length} system roles</>} />
      <Box className="asn-grid" style={{ marginBottom: 14 }}>
        <Box className="console-card" style={{ borderColor: "color-mix(in oklch, var(--info), transparent 78%)" }}>
          <Box className="ch" bg="color-mix(in oklch, var(--info), transparent 92%)">
            <Box as="span" className="cdot" bg="var(--info)" />
            <Box as="span" className="cn">system</Box>
            <Box as="span" className="repo">workspace-wide</Box>
            <Box as="span" className="spacer" />
            <Box as="span" className="hint mono">launched at startup · not reassignable</Box>
          </Box>
          {roles.map((p) => <AppSessionRow key={p.id} p={p} onOpen={onOpen} />)}
        </Box>
      </Box>

      <SectionHeader title="Console sessions" hint="each pane runs under one profile · the resolved command allowlist shows what actually runs there" meta={<>{consoles.length} consoles · {paneTotal} panes</>} />
      <Box style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
        <Box className="asn-grid">
          {consoles.map((c) => (
            <Box className="console-card" key={c.id}>
              <Box className="ch">
                <Box as="span" className="cdot" />
                <Box as="span" className="cn">{c.name}</Box>
                <Box as="span" className="repo">{c.repo}</Box>
                <Box as="span" className="spacer" />
                <Box as="span" className="hint mono">
                  project allow: {(c.projectAllow || []).join(", ") || "—"}{c.repoAllow ? ` · repo: ${c.repoAllow.join(", ")}` : ""}
                </Box>
              </Box>
              {c.panes.map((pane) => {
                const p = find(pane.profileId);
                const resolved = resolveAllowlistFrom(c, p);
                return (
                  <CardListRow
                    key={pane.id}
                    variant="grouped"
                    lead={<Box as="span" className={`pdot ${pane.status}`} />}
                    title={pane.agent}
                    subtitle={<Box as="span" className="mono">{pane.id}</Box>}
                    titleAside={<ProfileSelect current={p} profiles={profiles} onPick={(id) => onAssign(c.id, pane.id, id)} />}
                    body={
                      <Box className="resolved">
                        <Box as="span" className="lbl">runs:</Box>
                        {resolved.map((r) => (
                          <Box as="span" key={r.cmd} className={`rchip ${r.origin === "guaranteed" ? "guar" : ""}`} title={`from ${r.origin}`}>{r.cmd}</Box>
                        ))}
                        {resolved.length === 0 && <Box as="span" className="rchip">— prompt for everything —</Box>}
                      </Box>
                    }
                    trailing={<Button variant="ghost" style={{ height: 24, fontSize: 10 }} onClick={() => onOpen(pane.profileId)}>edit profile →</Button>}
                  />
                );
              })}
            </Box>
          ))}
        </Box>
      </Box>
    </>
  );
}
