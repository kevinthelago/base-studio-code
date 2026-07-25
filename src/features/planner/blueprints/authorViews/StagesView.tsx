// Blueprint Author — 2 · STAGES. Drag-reorder stage list with an inline editor
// (name · prompt module · dependencies) and an add-stage palette.

import { useState } from "react";
import { Ic } from "@/features/planner/blueprints/blueprintIcons";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { hue, tint, stageKind, STAGE_KIND_KEYS, DISPOSITIONS } from "@/features/planner/blueprints/blueprintCatalog";
import {
  reorderStages, addStage, deleteStage, toggleDep, setStageField, depCandidates,
} from "@/features/planner/blueprints/blueprintEdit";
import { Card } from "@/shared/ui/data/Card";
import { Button } from "@/shared/ui/controls/Button";
import { TextArea } from "@/shared/ui/controls/Field";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { BlueprintStage } from "@/features/planner/stages/blueprints";
import { Lbl, StageGlyph, type AuthorViewProps } from "./shared";

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
    <Box className="rail-list" pad={0} style={{ overflow: "visible" }}>
      {stages.map((s, i) => {
        const k = stageKind(s.key);
        const depNames = s.deps.map((d) => stages.find((x) => x.key === d)?.name || d);
        const locked = depNames.length > 0;
        const sel = s.uid === selectedUid;
        return (
          <Box key={s.uid}>
            {/* eslint-disable-next-line no-restricted-syntax, jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- drag-reorder + click-select stage node (blueprint author view); pointer-oriented, keyboard reorder is out of scope */}
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
                  {/* eslint-disable-next-line no-restricted-syntax -- bespoke .d-name inline stage-name input (transparent, no label) */}
                  <input className="d-name" style={{ fontSize: 13, minWidth: 0, flex: 1, marginLeft: 0 }}
                    value={s.name} onChange={(e) => setSections(setStageField(stages, s.uid, { name: e.target.value }))} />
                  <IconButton danger title="Delete stage" aria-label="Delete stage" onClick={() => {
                    const next = deleteStage(stages, s.uid);
                    setSections(next);
                    if (next[0]) onSelectStage?.(next[0].uid);
                  }}>🗑</IconButton>
                </Row>
                <Box className="d-kind" style={{ paddingLeft: 0, marginBottom: 11 }}>{k.title} · {k.blurb}</Box>

                <Lbl hint="what Claude is told in this stage">Prompt module</Lbl>
                <TextArea value={s.prompt} style={{ minHeight: 70, marginBottom: 13 }}
                  placeholder="Instructions for the planning agent during this stage…"
                  onChange={(v) => setSections(setStageField(stages, s.uid, { prompt: v }))} />

                <Lbl hint="stays locked until these complete">Dependencies</Lbl>
                {depCandidates(stages, s.uid).length === 0 ? (
                  <Text as="div" className="hint">First stage — nothing precedes it.</Text>
                ) : (
                  <Box className="dep-row">
                    {depCandidates(stages, s.uid).map((c) => {
                      const ck = stageKind(c.key); const on = s.deps.includes(c.key);
                      return (
                        // eslint-disable-next-line no-restricted-syntax -- bespoke .dep-chip dependency toggle (not .btn family)
                        <button key={c.uid} className={"dep-chip" + (on ? " on" : "")} onClick={() => setSections(toggleDep(stages, s.uid, c.key))}>
                          <Box as="span" className="dg" bg={tint(ck.h, 0.2)} style={{ color: hue(ck.h) }}><Ic n={ck.glyph} size={10} /></Box>
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
                  // eslint-disable-next-line no-restricted-syntax -- bespoke .pal-item stage-palette button (not .btn family)
                  <button className="pal-item" key={kk} title={k.blurb} onClick={() => add(kk)}>
                    <Box as="span" className="pg" bg={tint(k.h, 0.18)} style={{ color: hue(k.h) }}><Ic n={k.glyph} size={12} /></Box>
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
