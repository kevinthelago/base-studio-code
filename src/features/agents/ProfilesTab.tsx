// Agents — Profiles tab (#1643 split from AgentsWorkspace).
//
// The roles list (application + custom) + the selected profile's policy editor: base
// policy, shell allowlist, per-tool tri-states, filesystem + network scope, and the
// pane-assignment / app-session ownership panel. Composition + view only; all data
// transforms live in ./lib.

import { type CSSProperties } from "react";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { CardListRow } from "@/shared/ui/data/CardListRow";
import { Card } from "@/shared/ui/data/Card";
import { StatTile } from "@/shared/ui/data/StatTile";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";
import { Button } from "@/shared/ui/controls/Button";
import { Chip } from "@/shared/ui/data/Chip";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { IconBox } from "@/shared/ui/data/IconBox";
import { Banner } from "@/shared/ui/feedback/Banner";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { modeTone, originTone } from "./lib/badgeTone";
import {
  TOOL_DEFS, GUARANTEED, MODE_LABEL, paneCount, consoleCount,
  type AgentProfile, type ConsoleSession, type Tier, type ToolKey,
} from "./lib/agentProfiles";
import { appSessionOpenLabel, appReachNote } from "./lib/appSession";

const initialOf = (name: string) => name.replace(/[^a-z]/gi, "").slice(0, 2).toUpperCase();
const modeColor = (m: Tier) => m === "deny" ? "var(--danger)" : m === "ask" ? "var(--accent)" : "var(--success)";

export interface ProfilesTabProps {
  roles: AgentProfile[]; profiles: AgentProfile[]; consoles: ConsoleSession[];
  selected: AgentProfile;
  onSelect: (id: string) => void;
  setMode: (m: Tier) => void;
  setTool: (t: ToolKey, v: Tier) => void;
  removeCmd: (c: string) => void;
  addCmd: () => void;
  addPath: (kind: "allow" | "deny") => void;
  editPath: (kind: "allow" | "deny", index: number, value: string) => void;
  removePath: (kind: "allow" | "deny", index: number) => void;
  addHost: () => void;
  removeHost: (host: string) => void;
  toggleAssign: (consoleId: string, paneId: string) => void;
  find: (id: string) => AgentProfile | undefined;
  editable: boolean;
  onCreate: () => void;
  onDelete: (id: string) => void;
}

export function ProfilesTab(props: ProfilesTabProps) {
  const { roles, profiles, consoles, selected, onSelect, onCreate } = props;
  return (
    <Box className="prof-layout">
      <Card className="prof-list">
        <Box className="head">
          <Box className="head-row">
            <h3>Roles</h3>
            <Box as="span" className="hint">{roles.length} application · {profiles.length} custom</Box>
          </Box>
          {/* eslint-disable-next-line no-restricted-syntax -- uncontrolled placeholder filter input (no value/onChange), header toolbar; TextField's .field wrapper would change layout */}
          <input className="input" placeholder="filter…" style={{ marginTop: 8, height: 24, fontSize: 10.5 }} />
        </Box>
        <Box className="scroll">
          <Box className="list-label">Application · always present</Box>
          {roles.map((p) => <ProfRow key={p.id} p={p} on={p.id === selected.id} consoles={consoles} onClick={() => onSelect(p.id)} />)}
          <Box className="list-label">Custom &amp; generated</Box>
          {profiles.map((p) => <ProfRow key={p.id} p={p} on={p.id === selected.id} consoles={consoles} onClick={() => onSelect(p.id)} />)}
          <Box pad={[12, 14]}>
            <Button variant="ghost" style={{ width: "100%", justifyContent: "center" }} onClick={onCreate}>+ new role</Button>
          </Box>
        </Box>
      </Card>
      <Box className="prof-detail"><ProfDetail {...props} p={selected} /></Box>
    </Box>
  );
}

function ProfRow({ p, on, consoles, onClick }: { p: AgentProfile; on: boolean; consoles: ConsoleSession[]; onClick: () => void }) {
  const isApp = p.category === "application";
  const origin = isApp ? "application" : p.category === "generated" ? "generated" : (p.origin === "built-in" ? "built-in" : "user-defined");
  const obCls = isApp ? "approle" : p.category === "generated" ? "gen" : "";
  return (
    <CardListRow
      variant="grouped"
      accent={p.color}
      selected={on}
      onClick={onClick}
      lead={<ColorSwatch color={p.color} radius={3} style={{ display: "block" }} />}
      title={p.name}
      titleAside={<Chip tone={originTone(obCls)} size="xs">{origin}</Chip>}
      subtitle={
        <Box as="span" className="mono" style={{ fontSize: 9.5, color: "var(--fg-dim)", display: "inline-flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {isApp
            ? <><Text as="span">◆ owns {p.session}</Text><Text as="span">· always on</Text></>
            : <><Text as="span">{paneCount(p.id, consoles)} panes</Text><Text as="span">· {p.commands.length} cmds</Text></>}
        </Box>
      }
      trailing={<Chip tone={modeTone(p.mode)} size="xs">{p.mode}</Chip>}
    />
  );
}

function ProfDetail({ p, consoles, setMode, setTool, removeCmd, addCmd, addPath, editPath, removePath, addHost, removeHost, toggleAssign, find, editable, onDelete }: ProfilesTabProps & { p: AgentProfile }) {
  const isApp = p.category === "application";
  // Application roles are app-managed: lock their policy editors (visually + clicks).
  const lock: CSSProperties | undefined = editable ? undefined : { opacity: 0.55, pointerEvents: "none" };
  const originLabel = isApp ? "application · always on" : p.category === "generated" ? "generated" : (p.origin === "built-in" ? "built-in" : "user-defined");
  const allowPaths = p.paths.allow.length ? p.paths.allow : ["(none — read-only)"];
  return (
    <>
      <Box className="pd-head">
        <Box className="top">
          <Box as="span" className="pswatch" bg={p.color}>{isApp ? "◆" : initialOf(p.name)}</Box>
          <Box className="pt">
            <Box className="nm">
              {p.name}{" "}
              {isApp && <Chip tone="info" size="xs" style={{ verticalAlign: "middle" }}>application role</Chip>}
              {p.category === "generated" && <Chip tone="accent" size="xs" style={{ verticalAlign: "middle" }}>generated</Chip>}
            </Box>
            <Box className="ds">{p.desc}</Box>
          </Box>
          {isApp
            ? <><Button variant="ghost" style={{ height: 26, fontSize: 10.5 }}>open {appSessionOpenLabel(p)} →</Button><Button style={{ height: 26, fontSize: 10.5 }}>save</Button></>
            : <><Button variant="ghost" style={{ height: 26, fontSize: 10.5 }}>duplicate</Button><Button style={{ height: 26, fontSize: 10.5 }}>save</Button></>}
        </Box>
        {isApp && (
          <Stack gap={10} style={{ padding: "12px 18px", borderBottom: "1px solid var(--border-soft)" }}>
            <Banner tone="info" lead={<IconBox size={22} radius={6} background={p.color} fontSize={11} color="var(--on-accent)">◆</IconBox>}>
              <Text as="span"><b style={{ color: "var(--fg)" }}>System role.</b> Always present in every workspace — can't be deleted or assigned to a console pane. It runs as its own session.</Text>
            </Banner>
            <Box className="owns-card">
              <Box as="span" className="surf">{p.surfaceGlyph}</Box>
              <Box style={{ flex: 1 }}>
                <Box className="mono-value">Owns {p.owns}</Box>
                <Text as="div" mono size={10} tone="dim" style={{ marginTop: 2 }}>surface · {p.surface} &nbsp;·&nbsp; session · {p.session}</Text>
              </Box>
              <Chip tone="success" style={{ fontSize: 9.5 }}><StatusDot color="var(--success)" style={{ marginRight: 4 }} />running</Chip>
            </Box>
          </Stack>
        )}
        <Box className="pd-stat">
          <StatTile k="base policy" v={MODE_LABEL[p.mode]} vStyle={{ color: modeColor(p.mode) }} />
          <StatTile k={isApp ? "scope" : "assigned"} v={isApp ? "singleton session" : `${paneCount(p.id, consoles)} panes · ${consoleCount(p.id, consoles)} consoles`} />
          <StatTile k="commands" v={`${p.commands.length} + ${GUARANTEED.length} guaranteed`} />
          <StatTile k="origin" v={originLabel} />
        </Box>
      </Box>

      {/* base policy */}
      <Box className="pd-sec" style={lock}>
        <Box className="h"><h4>Base policy</h4><Box as="span" className="hint">applies to anything not listed below</Box></Box>
        <SegmentedControl
          size="md"
          options={(["deny", "ask", "allow"] as Tier[]).map((v) => ({
            label: v[0].toUpperCase() + v.slice(1),
            on: p.mode === v,
            onClick: () => setMode(v),
            tone: v,
            dot: true,
          }))}
        />
      </Box>

      {/* shell commands */}
      <Box className="pd-sec" style={lock}>
        <Box className="h">
          <h4>Shell commands</h4>
          <Box as="span" className="hint">allowlist — runs without a prompt</Box>
          <Box as="span" className="spacer" />
          <Box as="span" className="hint">unions with project + repo lists</Box>
        </Box>
        <Box className="cmd-chips">
          {GUARANTEED.map((c) => (
            <Box as="span" key={c} className="cmd-chip locked" title="guaranteed by backend — always available"><Box as="span" style={{ color: "var(--info)" }}>{c}</Box></Box>
          ))}
          {p.commands.map((c) => (
            <Box as="span" key={c} className="cmd-chip">{c}<Box as="span" className="x" onClick={() => removeCmd(c)}>×</Box></Box>
          ))}
          {/* eslint-disable-next-line no-restricted-syntax -- bespoke .cmd-add chip-add button (dashed add-chip), not a .btn */}
          <button className="cmd-add" onClick={addCmd}>+ add command</button>
        </Box>
        <Banner tone="neutral" style={{ marginTop: 9 }} lead={<Box as="span" style={{ color: "var(--info)" }}>ℹ</Box>}>
          <Text as="span"><b style={{ color: "var(--fg-muted)" }}>{GUARANTEED.join(", ")}</b> are always available.</Text>
          <Text as="span">Effective list also unions the console's project &amp; repo allowlists at run time.</Text>
        </Banner>
      </Box>

      {/* tools */}
      <Box className="pd-sec" style={lock}>
        <Box className="h"><h4>Tools</h4><Box as="span" className="hint">per-capability — allow runs silently, ask prompts you, deny blocks</Box></Box>
        <Box className="tool-table">
          {TOOL_DEFS.map(([t, d]) => (
            <Box className="tool-row" key={t}>
              <Box as="span" className="tn">{t}</Box>
              <Box as="span" className="td">{d}</Box>
              <Box as="span" style={{ justifySelf: "end" }}>
                <SegmentedControl
                  variant="joined"
                  options={(["deny", "ask", "allow"] as Tier[]).map((v) => ({
                    label: v,
                    on: p.tools[t] === v,
                    onClick: () => setTool(t, v),
                    tone: v,
                  }))}
                />
              </Box>
            </Box>
          ))}
        </Box>
      </Box>

      {/* filesystem */}
      <Box className="pd-sec" style={lock}>
        <Box className="h"><h4>Filesystem scope</h4><Box as="span" className="hint">globs the agent may write to / is blocked from</Box></Box>
        <Box className="scope-list">
          {allowPaths.map((g, i) => {
            const placeholder = g.startsWith("(");
            return (
              <Box className="scope-line" key={`a${i}`}>
                <Box as="span" className="gly allow">＋</Box>
                {/* eslint-disable-next-line no-restricted-syntax -- inline scope-line input (glyph + input + × in a flex row); TextField's .field wrapper would change layout */}
                <input
                  className="input"
                  value={g}
                  disabled={placeholder}
                  onChange={placeholder ? undefined : (e) => editPath("allow", i, e.target.value)}
                  style={placeholder ? { opacity: 0.5 } : undefined}
                />
                {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline .x remove glyph (scope-line styling, no aria-label), not an IconButton */}
                {!placeholder && <button className="x" onClick={() => removePath("allow", i)}>×</button>}
              </Box>
            );
          })}
          {p.paths.deny.map((g, i) => (
            <Box className="scope-line" key={`d${i}`}>
              <Box as="span" className="gly deny">－</Box>
              {/* eslint-disable-next-line no-restricted-syntax -- inline scope-line input (glyph + input + × in a flex row); TextField's .field wrapper would change layout */}
              <input className="input" value={g} onChange={(e) => editPath("deny", i, e.target.value)} />
              {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline .x remove glyph (scope-line styling, no aria-label), not an IconButton */}
              <button className="x" onClick={() => removePath("deny", i)}>×</button>
            </Box>
          ))}
          <Row gap={6} align="stretch" style={{ marginTop: 2 }}>
            {/* eslint-disable-next-line no-restricted-syntax -- bespoke .cmd-add chip-add button (dashed add-chip), not a .btn */}
            <button className="cmd-add" onClick={() => addPath("allow")}>+ allow path</button>
            {/* eslint-disable-next-line no-restricted-syntax -- bespoke .cmd-add chip-add button (dashed add-chip), not a .btn */}
            <button className="cmd-add" onClick={() => addPath("deny")}>+ deny path</button>
          </Row>
        </Box>
      </Box>

      {/* network */}
      <Box className="pd-sec" style={lock}>
        <Box className="h"><h4>Network</h4><Box as="span" className="hint">hosts the agent may reach (web / fetch tools)</Box></Box>
        {p.net.allow.length ? (
          <Box className="cmd-chips">
            {p.net.allow.map((h) => (
              <Box as="span" key={h} className="cmd-chip">{h === "*" ? <Text as="span" tone="accent">* all hosts</Text> : h}<Box as="span" className="x" onClick={() => removeHost(h)}>×</Box></Box>
            ))}
            {/* eslint-disable-next-line no-restricted-syntax -- bespoke .cmd-add chip-add button (dashed add-chip), not a .btn */}
            <button className="cmd-add" onClick={addHost}>+ add host</button>
          </Box>
        ) : (
          <>
            <Banner tone="neutral" style={{ marginTop: 9 }} lead={<Text as="span" tone="dim">⊘</Text>}>No outbound network. The web / fetch tools are blocked regardless of their tri-state above.</Banner>
            <Box className="cmd-chips" style={{ marginTop: 9 }}>
              {/* eslint-disable-next-line no-restricted-syntax -- bespoke .cmd-add chip-add button (dashed add-chip), not a .btn */}
              <button className="cmd-add" onClick={addHost}>+ add host</button>
            </Box>
          </>
        )}
      </Box>

      {/* assignments / ownership */}
      {isApp ? (
        <Box className="pd-sec">
          <Box className="h"><h4>Session</h4><Box as="span" className="hint">this role is not assignable — it is its own always-on session</Box></Box>
          <Box className="assign-mini">
            <Box className="row on" style={{ cursor: "default" }}>
              <Box className="check">◆</Box>
              <Box>
                <Box as="span" className="cn">{p.session}</Box>
                <Box className="pn">{p.surface} · launched at startup · 1 of 1</Box>
              </Box>
              <Text as="div" mono size={10} tone="success">always present</Text>
            </Box>
          </Box>
          <Banner tone="neutral" style={{ marginTop: 8 }} lead={<Box as="span" style={{ color: "var(--info)" }}>ℹ</Box>}>
            <Text as="span">{appReachNote(p)}</Text>
          </Banner>
        </Box>
      ) : (
        <Box className="pd-sec">
          <Box className="h"><h4>Assigned to</h4><Box as="span" className="hint">tick the console panes this profile governs</Box><Box as="span" className="spacer" /><Box as="span" className="hint">a profile can govern many panes</Box></Box>
          <Box className="assign-mini">
            {consoles.flatMap((c) => c.panes.map((pane) => {
              const on = pane.profileId === p.id;
              return (
                <Box key={`${c.id}|${pane.id}`} className={`row ${on ? "on" : ""}`} onClick={() => toggleAssign(c.id, pane.id)}>
                  <Box className="check">{on ? "✓" : ""}</Box>
                  <Box>
                    <Box as="span" className="cn">{c.name} <Text as="span" tone="dim">›</Text> {pane.agent}</Box>
                    <Box className="pn">{c.repo} · {pane.id}</Box>
                  </Box>
                  <Text as="div" mono size={10} tone="dim">{on ? "this profile" : `→ ${find(pane.profileId)?.name ?? pane.profileId}`}</Text>
                </Box>
              );
            }))}
          </Box>
        </Box>
      )}

      {!(isApp || p.builtin) && (
        <Box style={{ padding: "0 2px 6px" }}>
          <Button variant="ghost" danger style={{ height: 26, fontSize: 10.5 }} onClick={() => onDelete(p.id)}>delete profile</Button>
        </Box>
      )}
    </>
  );
}
