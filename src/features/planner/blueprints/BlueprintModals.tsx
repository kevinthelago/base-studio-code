// Blueprint gist + create modals (#609 slice 5) — ported from the design's gist.jsx.
// Faithful UI; the side-effecting flows (publish / import) take async callbacks so the
// page shell can wire them to the real gist client (gist.ts) while these stay testable.

import { useState, type ReactNode } from "react";
import "../../../styles/blueprints.css";
import { ModalScrim } from "@/shared/ui/overlay/ModalScrim";
import { Chip } from "@/shared/ui/data/Chip";
import { Ic } from "./blueprintIcons";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { Button } from "@/shared/ui/controls/Button";
import { IconBox } from "@/shared/ui/data/IconBox";
import { Card } from "@/shared/ui/data/Card";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { stageKind, tint, hue } from "./blueprintCatalog";
import { type Blueprint, type BlueprintStage } from "../stages/blueprints";
import { type SkillPayload } from "./blueprintSkills";

/** A resolved import/preview blueprint (subset enough to preview + import). */
export interface PreviewBlueprint {
  name: string; icon: string; h: number; author?: string; rev?: string; sections: BlueprintStage[];
  /** The upstream gist id this preview came from (#955) — recorded on import so a re-import is
   *  recognized (dedupe → update in place) and the import page can show its sync state. */
  gistId?: string;
  /** The fully-coerced blueprint (#897) — carried so import preserves blueprint-wide
   *  skills/mcp/category/mode instead of reconstructing from the lossy preview subset. */
  blueprint?: Blueprint;
  /** Skill content embedded in the share (#897 Phase 5b) — reconstituted into the library on import. */
  bundled?: SkillPayload[];
}

function Modal({ icon, iconBg, iconColor, title, sub, onClose, children, foot, lg }: {
  icon: ReactNode; iconBg?: string; iconColor?: string; title: string; sub?: string;
  onClose: () => void; children: ReactNode; foot?: ReactNode; lg?: boolean;
}) {
  return (
    <Box className="bp-page" style={{ position: "fixed", inset: 0 }}>
      <ModalScrim onDismiss={onClose} blur style={{ padding: 30 }}>
        <Box className="modal" bg="var(--bg-panel)" border radius="lg" style={{ width: lg ? 720 : 540, maxWidth: "100%", maxHeight: "88vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 70px rgba(0,0,0,.55)", overflow: "hidden" }}>
          <Row gap={11} className="modal-head" style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-soft)" }}>
            <IconBox size={30} radius={7} fontSize={13} background={iconBg ?? "color-mix(in oklch, var(--accent), transparent 84%)"} color={iconColor ?? "var(--accent)"}>{icon}</IconBox>
            <Box><Text as="h2" mono size="lg" weight={600} style={{ margin: 0 }}>{title}</Text>{sub && <Text as="div" size={10.5} tone="dim" style={{ marginTop: 1 }}>{sub}</Text>}</Box>
            <IconButton aria-label="close" style={{ marginLeft: "auto" }} onClick={onClose} />
          </Row>
          <Box className="modal-body" pad={20} style={{ overflowY: "auto" }}>{children}</Box>
          {foot && <Row gap={9} className="modal-foot" style={{ padding: "14px 20px", borderTop: "1px solid var(--border-soft)" }}>{foot}</Row>}
        </Box>
      </ModalScrim>
    </Box>
  );
}

export function StageSummary({ sections }: { sections: BlueprintStage[] }) {
  return (
    <Stack gap={4}>
      {sections.map((s, i) => {
        const k = stageKind(s.key);
        const caps = (s.skills?.length ?? 0) + (s.mcp?.length ?? 0);
        return (
          <Stack key={s.uid ?? i} gap={4} style={{ padding: "5px 0" }}>
            <Row gap={9}>
              <Box as="span" className="mono dim" style={{ fontSize: 9.5, width: 16 }}>{String(i + 1).padStart(2, "0")}</Box>
              <Box as="span" bg={tint(k.h, 0.16)} radius={5} style={{ width: 22, height: 22, flex: "0 0 22px", color: hue(k.h), display: "flex", alignItems: "center", justifyContent: "center" }}><Ic n={k.glyph} size={13} /></Box>
              <Text as="span" size={11.5} className="mono" style={{ color: "var(--fg)" }}>{s.name}</Text>
              <Box as="span" style={{ flex: 1 }} />
              {caps > 0 && <Text as="span" className="hint mono">{caps} attached</Text>}
              {s.gateRule && <Chip tone="accent">gate</Chip>}
            </Row>
            {/* The prompt is the substance of the stage (#1268) — dense text under the row, the
                icon as its index. pre-wrap keeps the prompt's own line breaks. */}
            {s.prompt?.trim() && (
              <Box className="mono" style={{ marginLeft: 25, fontSize: 10, lineHeight: 1.5, color: "var(--fg-dim)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {s.prompt.trim()}
              </Box>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}

/* ── Import ── */
export function ImportModal({ onClose, onResolve, onImport }: {
  onClose: () => void;
  onResolve: (ref: string) => Promise<PreviewBlueprint>;
  onImport: (preview: PreviewBlueprint) => void;
}) {
  const [val, setVal] = useState("");
  const [phase, setPhase] = useState<"input" | "loading" | "preview" | "error">("input");
  const [preview, setPreview] = useState<PreviewBlueprint | null>(null);
  const [err, setErr] = useState("");

  async function resolve() {
    if (!val.trim()) return;
    setPhase("loading");
    try { setPreview(await onResolve(val.trim())); setPhase("preview"); }
    catch (e) { setErr(String(e)); setPhase("error"); }
  }

  return (
    <Modal icon={<Ic n="cloud_download" size={15} />} title="Import from gist" sub="Pull a blueprint someone shared with you" onClose={onClose}
      foot={phase === "preview" && preview
        ? <><Text as="span" className="hint">Imports as a linked copy — you can sync upstream later</Text><Box as="span" style={{ flex: 1 }} /><Button variant="ghost" onClick={() => setPhase("input")}>Back</Button><Button variant="primary" onClick={() => onImport(preview)}>Import to library</Button></>
        : <><Box as="span" style={{ flex: 1 }} /><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!val.trim() || phase === "loading"} onClick={resolve}>{phase === "loading" ? "Resolving…" : "Resolve gist"}</Button></>}>
      {phase === "preview" && preview ? (
        <>
          <Row gap={10} style={{ marginBottom: 12 }}>
            <IconBox size={30} radius={8} fontSize={14} background={tint(preview.h, 0.16)} color={hue(preview.h)}>{preview.icon}</IconBox>
            <Box><Text as="div" size={13} weight={600} className="mono">{preview.name}</Text><Text as="div" className="hint mono">{preview.author ? `by ${preview.author} · ` : ""}{preview.rev ? `revision ${preview.rev} · ` : ""}{preview.sections.length} stages</Text></Box>
            <Box as="span" style={{ flex: 1 }} /><Chip tone="info">valid blueprint</Chip>
          </Row>
          <Card style={{ padding: 13 }}><StageSummary sections={preview.sections} /></Card>
        </>
      ) : (
        <Box className="field">
          <label className="mono" style={{ fontSize: 10, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: ".06em" }}>Gist URL or ID</label>
          {/* eslint-disable-next-line no-restricted-syntax -- bespoke .field block: custom-styled <label> (10px/.06em) + input marginTop + a separate error sibling; TextField's plain-label .field stack wouldn't match */}
          <input className="input" autoFocus style={{ marginTop: 6 }} placeholder="gist.github.com/user/a91f3c0e7  ·  or  ·  a91f3c0e7"
            value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void resolve(); }} />
          <Box className="hint" style={{ marginTop: 6 }}>Paste a full URL or the raw gist ID.</Box>
          {phase === "error" && <Box className="mono" style={{ color: "var(--danger)", fontSize: 11, marginTop: 10 }}>Couldn't resolve: {err}</Box>}
        </Box>
      )}
    </Modal>
  );
}
