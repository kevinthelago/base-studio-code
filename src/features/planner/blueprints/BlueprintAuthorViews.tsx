// The four interactive Blueprint Author phase views (#923), ported from the design's
// blueprint-author/views.jsx and adapted to the current model: stages carry skills + MCP +
// output disposition (NOT pipelines — #897 removed those). Each view edits the in-progress
// blueprint and emits the whole thing via `onChange`; the planner also drives it via the
// <blueprint> tag, so editing and the live session stay in sync. Styling reuses blueprints.css.

import { useState, type CSSProperties } from "react";
import { useExpandable } from "@/shared/hooks/useExpandable";
import { Sparkles } from "lucide-react";
import "../../../styles/blueprints.css";
import { Ic } from "./blueprintIcons";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { Chip } from "@/shared/ui/data/Chip";
import {
  hue, tint, stageKind, STAGE_KIND_KEYS, DISPOSITIONS, DISPOSITION_KEYS,
} from "./blueprintCatalog";
import {
  reorderStages, addStage, deleteStage, toggleDep, setOutput, setStageField,
  addSkill, removeSkill, addMcpServer, removeMcpServer, depCandidates,
} from "./blueprintEdit";
import { IconBox } from "@/shared/ui/data/IconBox";
import { Card } from "@/shared/ui/data/Card";
import { Button } from "@/shared/ui/controls/Button";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { Blueprint, BlueprintStage } from "../stages/blueprints";
import type { BlueprintSkillItem } from "./blueprintSkills";
import type { McpLibraryItem } from "./blueprintMcp";

const gateCount = (s: BlueprintStage) => (s.gateRule ? 1 : 0);

export interface AuthorViewProps {
  bp: Blueprint;
  onChange: (bp: Blueprint) => void;
  /** Pickable skill/knowledge + MCP libraries (Capabilities stage). */
  skillLibrary?: BlueprintSkillItem[];
  mcpLibrary?: McpLibraryItem[];
  /** Selected stage in the Stages editor. */
  selectedUid?: string | null;
  onSelectStage?: (uid: string | null) => void;
  /** Publish the authored blueprint (Review stage); visibility comes from `bp.visibility`. */
  onPublish?: () => void;
  published?: boolean;
}

function Lbl({ children, hint, style }: { children: React.ReactNode; hint?: string; style?: CSSProperties }) {
  return <Box className="lbl" style={style}>{children}<Box as="span" className="ln" />{hint && <Text as="span" className="lhint">{hint}</Text>}</Box>;
}

function StageGlyph({ k, size = 26 }: { k: string; size?: number }) {
  const meta = stageKind(k);
  return (
    <Box as="span" style={{ width: size, height: size, flex: `0 0 ${size}px`, borderRadius: 6,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: tint(meta.h, 0.16), color: hue(meta.h) }}>
      <Ic n={meta.glyph} size={size * 0.56} />
    </Box>
  );
}

/* ── 1 · PURPOSE ─────────────────────────────────────────────────────────── */
const HUE_CHOICES = [195, 25, 70, 145, 230, 295, 350];
const TAGS = ["backend", "frontend", "realtime", "api", "data", "ml", "mobile", "infra", "lean"];

export function PurposeView({ bp, onChange }: AuthorViewProps) {
  const set = (patch: Partial<Blueprint>) => onChange({ ...bp, ...patch });
  const tags = bp.tags ?? [];
  const toggleTag = (t: string) => set({ tags: tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t] });
  const h = bp.h ?? 195;
  const stages = bp.sections ?? [];

  return (
    <Stack gap={18}>
      <Box>
        <Lbl hint="name & accent">Identity</Lbl>
        <Row gap={11} align="start">
          <Stack gap={7} align="center">
            <Box as="span" className="ed-icon" style={{ width: 44, height: 44, fontSize: 19, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 9,
              background: tint(h, 0.18), color: hue(h), border: `1px solid ${tint(h, 0.4)}` }}>{bp.icon || (bp.name?.[0] ?? "B").toUpperCase()}</Box>
            <Row gap={4}>
              {HUE_CHOICES.map((c) => (
                <Box as="span" key={c} onClick={() => set({ h: c })} title="accent hue"
                  style={{ width: 13, height: 13, borderRadius: 4, cursor: "pointer", background: hue(c),
                    outline: h === c ? "2px solid var(--fg)" : "none", outlineOffset: 1 }} />
              ))}
            </Row>
          </Stack>
          <Stack gap={8} style={{ flex: 1 }}>
            <input className="input" value={bp.name} placeholder="Blueprint name" style={{ fontSize: 13 }}
              onChange={(e) => set({ name: e.target.value, icon: (e.target.value[0] || "B").toUpperCase() })} />
            <input className="input" value={bp.pitch ?? ""} placeholder="One-line pitch — shown in the catalog"
              onChange={(e) => set({ pitch: e.target.value })} />
          </Stack>
        </Row>
      </Box>

      <Box>
        <Lbl hint="what it's for & why">Description</Lbl>
        <textarea className="input" value={bp.desc ?? ""} style={{ minHeight: 78 }}
          placeholder="Describe the kind of project this blueprint plans…"
          onChange={(e) => set({ desc: e.target.value })} />
      </Box>

      <Box>
        <Lbl>Audience</Lbl>
        <input className="input" value={bp.audience ?? ""} placeholder="Who plans with this"
          onChange={(e) => set({ audience: e.target.value })} />
      </Box>

      <Box>
        <Lbl hint="catalog tags · pick a few">Best for</Lbl>
        <Box className="dep-row">
          {TAGS.map((t) => (
            <button key={t} className={"dep-chip" + (tags.includes(t) ? " on" : "")} onClick={() => toggleTag(t)}>
              {t}{tags.includes(t) && <Text as="span" style={{ opacity: 0.7 }}> ✓</Text>}
            </button>
          ))}
        </Box>
      </Box>

      <Box>
        <Lbl hint="how it appears in the library">Catalog preview</Lbl>
        <Box className="bp-card" style={{ cursor: "default" }}>
          <Box className="bp-top">
            <IconBox size={34} radius={8} fontSize={15} background={tint(h, 0.16)} color={hue(h)} border={`1px solid ${tint(h, 0.4)}`}>{bp.icon || (bp.name?.[0] ?? "B").toUpperCase()}</IconBox>
            <Box style={{ minWidth: 0 }}>
              <h3>{bp.name || "Untitled blueprint"}</h3>
              <p className="bp-desc">{bp.pitch || "Add a one-line pitch…"}</p>
            </Box>
          </Box>
          <Box className="seq">
            {stages.slice(0, 6).map((s, i) => {
              const k = stageKind(s.key);
              return (
                <Box as="span" key={s.uid} style={{ display: "contents" }}>
                  {i > 0 && <Text as="span" className="arr">→</Text>}
                  <Box as="span" className={"st-g" + (gateCount(s) ? " gated" : "")} title={k.title}><Ic n={k.glyph} size={11} /></Box>
                </Box>
              );
            })}
            {stages.length > 6 && <Text as="span" className="more">+{stages.length - 6}</Text>}
          </Box>
          <Box className="bp-foot">
            <Text as="span">{stages.length} stage{stages.length === 1 ? "" : "s"}</Text>
            <Box as="span" className="sp" />
            {tags.slice(0, 3).map((t) => <Chip key={t}>{t}</Chip>)}
          </Box>
        </Box>
      </Box>
    </Stack>
  );
}

/* ── 2 · STAGES ──────────────────────────────────────────────────────────── */
export function StagesView({ bp, onChange, selectedUid, onSelectStage }: AuthorViewProps) {
  const stages = bp.sections ?? [];
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const setSections = (next: BlueprintStage[]) => onChange({ ...bp, sections: next });
  const used = new Set(stages.map((s) => s.key));

  const add = (key: string) => {
    const next = addStage(stages, key);
    setSections(next);
    onSelectStage?.(next[next.length - 1].uid);
    setAdding(false);
  };

  return (
    <Box className="rail-list" style={{ padding: 0, overflow: "visible" }}>
      {stages.map((s, i) => {
        const k = stageKind(s.key);
        const depNames = s.deps.map((d) => stages.find((x) => x.key === d)?.name || d);
        const locked = depNames.length > 0;
        const sel = s.uid === selectedUid;
        return (
          <Box key={s.uid}>
            <div
              className={"stage" + (sel ? " is-sel" : "") + (locked ? " locked" : "") + (dragIdx === i ? " dragging" : "") + (overIdx === i && dragIdx !== null && dragIdx !== i ? " dragover" : "")}
              draggable
              onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(e) => { e.preventDefault(); if (i !== overIdx) setOverIdx(i); }}
              onDrop={(e) => { e.preventDefault(); if (dragIdx !== null && dragIdx !== i) setSections(reorderStages(stages, dragIdx, i)); setDragIdx(null); setOverIdx(null); }}
              onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
              onClick={() => onSelectStage?.(sel ? null : s.uid)}>
              <Text as="span" className="grip" title="Drag to reorder">⠿</Text>
              <Text as="span" className="snum">{String(i + 1).padStart(2, "0")}</Text>
              <StageGlyph k={s.key} />
              <Box as="span" className="sbody">
                <Box as="span" className="sname">{s.name}{locked && <Text as="span" className="lock" title={"depends on " + depNames.join(", ")}> 🔒</Text>}</Box>
                <Box as="span" className="smeta">
                  {(s.skills?.length ?? 0) > 0 && <Text as="span">{s.skills!.length} skill{s.skills!.length > 1 ? "s" : ""}</Text>}
                  {(s.mcp?.length ?? 0) > 0 && <Text as="span">{s.mcp!.length} MCP</Text>}
                  {locked && <Text as="span">↳ {depNames.join(", ")}</Text>}
                  {!(s.skills?.length || s.mcp?.length) && !locked && <Text as="span" className="dim">{DISPOSITIONS[s.output ?? ""]?.title ?? "plan file"}</Text>}
                </Box>
              </Box>
            </div>

            {sel && (
              <Card style={{ margin: "2px 4px 8px 30px", padding: 13 }}>
                <Row gap={8} style={{ marginBottom: 11 }}>
                  <input className="d-name" style={{ fontSize: 13, minWidth: 0, flex: 1, marginLeft: 0 }}
                    value={s.name} onChange={(e) => setSections(setStageField(stages, s.uid, { name: e.target.value }))} />
                  <button className="icon-btn danger" title="Delete stage" aria-label="Delete stage" onClick={() => {
                    const next = deleteStage(stages, s.uid);
                    setSections(next);
                    if (next[0]) onSelectStage?.(next[0].uid);
                  }}>🗑</button>
                </Row>
                <Box className="d-kind" style={{ paddingLeft: 0, marginBottom: 11 }}>{k.title} · {k.blurb}</Box>

                <Lbl hint="what Claude is told in this stage">Prompt module</Lbl>
                <textarea className="input" value={s.prompt} style={{ minHeight: 70, marginBottom: 13 }}
                  placeholder="Instructions for the planning agent during this stage…"
                  onChange={(e) => setSections(setStageField(stages, s.uid, { prompt: e.target.value }))} />

                <Lbl hint="stays locked until these complete">Dependencies</Lbl>
                {depCandidates(stages, s.uid).length === 0 ? (
                  <Text as="div" className="hint">First stage — nothing precedes it.</Text>
                ) : (
                  <Box className="dep-row">
                    {depCandidates(stages, s.uid).map((c) => {
                      const ck = stageKind(c.key); const on = s.deps.includes(c.key);
                      return (
                        <button key={c.uid} className={"dep-chip" + (on ? " on" : "")} onClick={() => setSections(toggleDep(stages, s.uid, c.key))}>
                          <Box as="span" className="dg" style={{ background: tint(ck.h, 0.2), color: hue(ck.h) }}><Ic n={ck.glyph} size={10} /></Box>
                          {c.name}{on && <Text as="span" style={{ opacity: 0.7 }}> ✓</Text>}
                        </button>
                      );
                    })}
                  </Box>
                )}
              </Card>
            )}

            {i < stages.length - 1 && <Box className={"stage-conn" + (stages[i + 1].deps.includes(s.key) ? " dep" : "")} />}
          </Box>
        );
      })}

      <Box className="addstage">
        {!adding ? (
          <Button variant="ghost" size="sm" style={{ width: "100%", justifyContent: "center", borderStyle: "dashed", marginTop: 8 }} onClick={() => setAdding(true)}>+ Add stage</Button>
        ) : (
          <Card style={{ padding: 11, marginTop: 8 }}>
            <Row gap={0} style={{ marginBottom: 6 }}>
              <Text as="span" size={11} tone="muted" mono style={{ textTransform: "uppercase", letterSpacing: ".06em" }}>Add a stage</Text>
              <Box as="span" style={{ flex: 1 }} />
              <IconButton aria-label="cancel" onClick={() => setAdding(false)} />
            </Row>
            <Box className="palette">
              {STAGE_KIND_KEYS.map((kk) => {
                const k = stageKind(kk);
                return (
                  <button className="pal-item" key={kk} title={k.blurb} onClick={() => add(kk)}>
                    <Box as="span" className="pg" style={{ background: tint(k.h, 0.18), color: hue(k.h) }}><Ic n={k.glyph} size={12} /></Box>
                    <Box as="span" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k.title}{used.has(kk) && <Text as="span" className="dim"> ·</Text>}</Box>
                  </button>
                );
              })}
            </Box>
          </Card>
        )}
      </Box>
    </Box>
  );
}

/* ── 3 · CAPABILITIES (disposition · skills · MCP) ───────────────────────── */
export function CapabilitiesView({ bp, onChange, skillLibrary = [], mcpLibrary = [] }: AuthorViewProps) {
  const stages = bp.sections ?? [];
  const { open, toggle } = useExpandable(stages[0] ? [stages[0].uid] : []);
  const setSections = (next: BlueprintStage[]) => onChange({ ...bp, sections: next });

  const totalSkills = new Set(stages.flatMap((s) => s.skills ?? [])).size;
  const totalMcp = new Set(stages.flatMap((s) => s.mcp ?? [])).size;

  return (
    <Stack gap={12}>
      <Box className="stats" style={{ gridTemplateColumns: "repeat(3,1fr)", marginBottom: 4 }}>
        <Box className="stat"><Text as="div" className="sk">stages</Text><Text as="div" className="sv">{stages.length}</Text></Box>
        <Box className="stat"><Text as="div" className="sk">skills wired</Text><Text as="div" className="sv">{totalSkills}</Text></Box>
        <Box className="stat"><Text as="div" className="sk">MCP wired</Text><Text as="div" className="sv">{totalMcp}</Text></Box>
      </Box>

      {stages.map((s) => {
        const isOpen = open.has(s.uid);
        const attachedSkills = s.skills ?? [];
        const attachedMcp = s.mcp ?? [];
        const addableSkills = skillLibrary.filter((sk) => !attachedSkills.includes(sk.id));
        const addableMcp = mcpLibrary.filter((m) => !attachedMcp.includes(m.id));
        return (
          <Card key={s.uid} style={{ padding: 0, overflow: "hidden" }}>
            <Row gap={10} style={{ padding: "11px 13px", cursor: "pointer" }} onClick={() => toggle(s.uid)}>
              <StageGlyph k={s.key} />
              <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Text as="span" className="mono-value">{s.name}</Text>
                <Box as="span" style={{ fontSize: 10, color: "var(--fg-dim)", display: "flex", gap: 8 }}>
                  <Text as="span">{attachedSkills.length} skill{attachedSkills.length !== 1 ? "s" : ""}</Text>
                  <Text as="span">{attachedMcp.length} MCP</Text>
                  <Text as="span">→ {DISPOSITIONS[s.output ?? ""]?.title ?? "plan file"}</Text>
                </Box>
              </Stack>
              <Text as="span" size={10} className="dim mono">{isOpen ? "▼" : "▶"}</Text>
            </Row>

            {isOpen && (
              <Box style={{ padding: "0 13px 14px", borderTop: "1px solid var(--border-soft)" }}>
                <Lbl style={{ marginTop: 13 }} hint="what happens to the artifact">Output disposition</Lbl>
                <Box className="disp-grid">
                  {DISPOSITION_KEYS.map((key) => {
                    const d = DISPOSITIONS[key];
                    return (
                      <Box className={"disp" + (s.output === key ? " on" : "")} key={key} onClick={() => setSections(setOutput(stages, s.uid, key))}>
                        <Box as="span" className="dgl" style={{ background: tint(d.h, 0.16), color: hue(d.h) }}><Ic n={d.glyph} size={13} /></Box>
                        <Box as="span" className="dtxt"><Text as="div" className="dt">{d.title}</Text><Text as="div" className="dd">{d.desc}</Text></Box>
                      </Box>
                    );
                  })}
                </Box>

                <Lbl style={{ marginTop: 18 }} hint="injected context for this stage"><Sparkles size={12} style={{ verticalAlign: "-2px", marginRight: 5, opacity: 0.85 }} />Skills &amp; knowledge</Lbl>
                {attachedSkills.length === 0 && <Box className="hint" style={{ marginBottom: 8 }}>No skills attached.</Box>}
                {attachedSkills.length > 0 && (
                  <Box className="dep-row" style={{ marginBottom: 8 }}>
                    {attachedSkills.map((id) => {
                      const sk = skillLibrary.find((x) => x.id === id);
                      return (
                        <Box as="span" className="dep-chip on" key={id} title={sk?.desc}>
                          {sk && <Text as="span" className="dim" size={8.5}>{sk.kind} </Text>}{sk?.name ?? id}
                          <Box as="span" style={{ cursor: "pointer", opacity: 0.8 }} onClick={() => setSections(removeSkill(stages, s.uid, id))}> ✕</Box>
                        </Box>
                      );
                    })}
                  </Box>
                )}
                {addableSkills.length > 0 && (
                  <Box className="pipe-add">
                    {addableSkills.map((sk) => <button className="chip-sug" key={sk.id} title={sk.desc} onClick={() => setSections(addSkill(stages, s.uid, sk.id))}>+ {sk.name}</button>)}
                  </Box>
                )}

                <Lbl style={{ marginTop: 18 }} hint="tools this stage's agents can call">MCP servers</Lbl>
                {attachedMcp.length === 0 && <Box className="hint" style={{ marginBottom: 8 }}>No MCP servers attached.</Box>}
                {attachedMcp.length > 0 && (
                  <Box className="dep-row" style={{ marginBottom: 8 }}>
                    {attachedMcp.map((name) => (
                      <Box as="span" className="dep-chip on" key={name} title={mcpLibrary.find((m) => m.id === name)?.desc}>
                        {name}
                        <Box as="span" style={{ cursor: "pointer", opacity: 0.8 }} onClick={() => setSections(removeMcpServer(stages, s.uid, name))}> ✕</Box>
                      </Box>
                    ))}
                  </Box>
                )}
                {addableMcp.length > 0 && (
                  <Box className="pipe-add">
                    {addableMcp.map((m) => <button className="chip-sug" key={m.id} title={m.desc} onClick={() => setSections(addMcpServer(stages, s.uid, m.id))}>+ {m.name}</button>)}
                  </Box>
                )}
              </Box>
            )}
          </Card>
        );
      })}
    </Stack>
  );
}

/* ── 4 · REVIEW & PUBLISH ────────────────────────────────────────────────── */
interface PublishCheck { id: string; label: string; ok: boolean; detail: string }

export function authoringChecks(bp: Blueprint): PublishCheck[] {
  const stages = bp.sections ?? [];
  const tags = bp.tags ?? [];
  const emptyPrompts = stages.filter((s) => !s.prompt?.trim()).length;
  return [
    { id: "name", label: "Name & pitch set", ok: !!bp.name?.trim() && !!bp.pitch?.trim(), detail: bp.name?.trim() && bp.pitch?.trim() ? "ok" : "missing" },
    { id: "tags", label: "At least one catalog tag", ok: tags.length > 0, detail: `${tags.length} tag${tags.length === 1 ? "" : "s"}` },
    { id: "count", label: "Two or more stages", ok: stages.length >= 2, detail: `${stages.length} stage${stages.length === 1 ? "" : "s"}` },
    { id: "prompts", label: "Every stage has a prompt module", ok: stages.length > 0 && emptyPrompts === 0, detail: `${emptyPrompts} empty` },
  ];
}

const VIS: { key: NonNullable<Blueprint["visibility"]>; glyph: string; title: string; desc: string }[] = [
  { key: "local", glyph: "folder", title: "Local only", desc: "Stays in your library." },
  { key: "private-gist", glyph: "lock", title: "Private gist", desc: "Shareable by link." },
  { key: "catalog", glyph: "public", title: "Public gist", desc: "Discoverable by everyone." },
];

export function PublishView({ bp, onChange, onPublish, published }: AuthorViewProps) {
  const stages = bp.sections ?? [];
  const h = bp.h ?? 195;
  const checks = authoringChecks(bp);
  const passed = checks.filter((c) => c.ok).length;
  const allPass = passed === checks.length;
  const vis = bp.visibility ?? "private-gist";
  const totalSkills = new Set(stages.flatMap((s) => s.skills ?? [])).size;
  const totalMcp = new Set(stages.flatMap((s) => s.mcp ?? [])).size;

  return (
    <Stack gap={16}>
      <Box className="hero" style={{ marginBottom: 0 }}>
        <Box as="span" className="hicon" style={{ background: tint(h, 0.16), color: hue(h) }}>{bp.icon || (bp.name?.[0] ?? "B").toUpperCase()}</Box>
        <Box className="htxt">
          <Text as="div" className="heyebrow">blueprint</Text>
          <Box className="mono" style={{ fontSize: 14, color: "var(--fg)", marginBottom: 3 }}>{bp.name || "Untitled blueprint"}</Box>
          <Text as="div" className="hbody">{bp.pitch || "—"}</Text>
        </Box>
      </Box>

      <Box className="stats" style={{ gridTemplateColumns: "repeat(4,1fr)", margin: 0 }}>
        <Box className="stat"><Text as="div" className="sk">stages</Text><Text as="div" className="sv">{stages.length}</Text></Box>
        <Box className="stat"><Text as="div" className="sk">skills</Text><Text as="div" className="sv">{totalSkills}</Text></Box>
        <Box className="stat"><Text as="div" className="sk">MCP</Text><Text as="div" className="sv">{totalMcp}</Text></Box>
        <Box className="stat"><Text as="div" className="sk">checks</Text><Text as="div" className={"sv" + (allPass ? " ok" : "")}>{passed}/{checks.length}</Text></Box>
      </Box>

      <Box>
        <Lbl>Flow</Lbl>
        <Box className="seq" style={{ gap: 5 }}>
          {stages.map((s, i) => {
            const k = stageKind(s.key);
            return (
              <Box as="span" key={s.uid} style={{ display: "contents" }}>
                {i > 0 && <Text as="span" className="arr">→</Text>}
                <Box as="span" className={"st-g" + (gateCount(s) ? " gated" : "")} title={s.name} style={{ width: 24, height: 24 }}><Ic n={k.glyph} size={13} /></Box>
              </Box>
            );
          })}
        </Box>
      </Box>

      <Box>
        <Lbl hint="lint · must pass to publish">Validation</Lbl>
        <Stack gap={5}>
          {checks.map((c) => (
            <Box key={c.id} className={"diff-line " + (c.ok ? "add" : "del")} style={{ marginBottom: 0 }}>
              <Text as="span" className="dmark">{c.ok ? "✓" : "✕"}</Text>
              <Text as="span" className="dtitle">{c.label}</Text>
              <Box as="span" style={{ flex: 1 }} />
              <Text as="span" size={10} className="dim">{c.detail}</Text>
            </Box>
          ))}
        </Stack>
      </Box>

      <Box>
        <Lbl>Visibility</Lbl>
        <Box className="disp-grid" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
          {VIS.map((v) => (
            <Box key={v.key} className={"disp" + (vis === v.key ? " on" : "")} style={{ flexDirection: "column", alignItems: "flex-start", gap: 6 }}
              onClick={() => onChange({ ...bp, visibility: v.key })}>
              <Box as="span" className="dgl" style={{ background: vis === v.key ? tint(h, 0.18) : "var(--bg-elev)", color: vis === v.key ? hue(h) : "var(--fg-muted)" }}><Ic n={v.glyph} size={13} /></Box>
              <Box as="span" className="dtxt"><Text as="div" className="dt">{v.title}</Text><Text as="div" className="dd">{v.desc}</Text></Box>
            </Box>
          ))}
        </Box>
      </Box>

      <Button variant="primary" disabled={!allPass || published} onClick={onPublish}
        style={{ height: 38, justifyContent: "center", fontSize: 12 }}>
        {published ? "✓ Published"
          : allPass ? <Box as="span" style={{ display: "flex", alignItems: "center", gap: 7 }}><Ic n="upload" size={14} /> {vis === "local" ? "Save to library" : "Publish blueprint"}</Box>
          : `Resolve ${checks.length - passed} check${checks.length - passed > 1 ? "s" : ""} to publish`}
      </Button>
    </Stack>
  );
}
