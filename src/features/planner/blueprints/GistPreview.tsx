// The expanded preview under a gist row: what the user is about to download — the blueprint's
// stages (the structured view that drives the decision) + the raw JSON file itself.
// (Extracted from BlueprintImportModal.tsx — behavior-preserving, #2128.)

import { useState, type CSSProperties } from "react";
import { AlertTriangle, Loader2, FileJson } from "lucide-react";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Code } from "@/shared/ui/data/Code";
import { StageSummary } from "./BlueprintModals";
import { spin, type PreviewEntry } from "./blueprintImport.helpers";

export function GistPreview({ entry }: { entry?: PreviewEntry }) {
  const [raw, setRaw] = useState(false);
  const box: CSSProperties = {
    margin: "-3px 0 9px", padding: "11px 13px", borderRadius: "var(--r-md)",
    background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
    fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)",
  };
  if (!entry || entry.loading) {
    return <Row gap={8} style={box}><Loader2 size={12} style={spin} />reading the blueprint…</Row>;
  }
  if (entry.error) {
    return <Row align="start" gap={8} style={{ ...box, color: "var(--danger)" }}><AlertTriangle size={13} style={{ flex: "0 0 auto", marginTop: 1 }} />couldn't read this blueprint: {entry.error}</Row>;
  }
  const p = entry.data!;
  const bp = p.blueprint;                          // the fully-coerced blueprint, when present
  const sections = bp?.sections ?? p.sections;     // top-level sections always exist
  const caps = sections.reduce((n, s) => n + (s.skills?.length ?? 0) + (s.mcp?.length ?? 0), 0);
  return (
    <Box style={box}>
      <Box style={{ color: "var(--fg-dim)", marginBottom: 8 }}>
        {bp?.category ?? "greenfield"}{bp?.mode ? ` · ${bp.mode}` : ""} · {sections.length} stage{sections.length === 1 ? "" : "s"}{caps > 0 ? ` · ${caps} attached` : ""}
      </Box>
      <StageSummary sections={sections} />
      {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline text-button (view/hide raw JSON toggle; not .btn family) */}
      <button
        onClick={() => setRaw((r) => !r)}
        className="mono"
        style={{ marginTop: 9, background: "none", border: 0, padding: 0, cursor: "pointer", color: "var(--fg-dim)", fontSize: 10, display: "inline-flex", alignItems: "center", gap: 5 }}
      ><FileJson size={11} />{raw ? "hide" : "view"} raw JSON</button>
      {raw && (
        <Code wrap={false} maxHeight={220} style={{ marginTop: 7, padding: 10, borderRadius: "var(--r-md)", background: "var(--bg-elev)" }}>
          {JSON.stringify(bp ?? { name: p.name, sections }, null, 2)}
        </Code>
      )}
    </Box>
  );
}
