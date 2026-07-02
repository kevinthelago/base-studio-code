// GitHub structure card, split out of Planning.tsx (#1332).
//
// A live map of the GitHub objects this plan produces. Each node mirrors a real GitHub primitive
// (repository, project board, milestone, issue) and carries a status that the publish flow updates
// in place so the user can watch each object get created.
import type { GhNode, GhRepoNode, GhStructure } from "../github/ghStructure";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

export type GhItemStatus = "planned" | "running" | "created" | "exists" | "skipped" | "error";
export interface GhItemState { status: GhItemStatus; detail?: string; url?: string; }
export type GhStatusMap = Record<string, GhItemState>;

const GH_STATUS_GLYPH: Record<GhItemStatus, { icon: string; color: string }> = {
  planned: { icon: "○", color: "var(--fg-dim)" },
  running: { icon: "⟳", color: "var(--accent)" },
  created: { icon: "✓", color: "var(--success)" },
  exists:  { icon: "=", color: "var(--info)" },
  skipped: { icon: "–", color: "var(--fg-dim)" },
  error:   { icon: "✗", color: "var(--danger)" },
};

function GhItemRow({ node, state }: { node: GhNode; state: GhItemState }) {
  const g = GH_STATUS_GLYPH[state.status];
  return (
    <Row className="mono" align="baseline" gap={8} style={{
      fontSize: 10.5,
      opacity: state.status === "planned" ? 0.6 : 1,
    }}>
      <Box as="span" style={{ width: 11, textAlign: "center", flexShrink: 0, color: g.color }}>{g.icon}</Box>
      <Box as="span" style={{
        color: state.status === "error" ? "var(--danger)" : "var(--fg)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{node.label}</Box>
      {state.url ? (
        <a href={state.url} target="_blank" rel="noreferrer"
          style={{ color: "var(--fg-dim)", fontSize: 9.5, textDecoration: "none" }}
          title={state.url}>
          {state.detail ?? "open"} ↗
        </a>
      ) : state.detail ? (
        <Text as="span" tone="dim" size={9.5}>· {state.detail}</Text>
      ) : null}
    </Row>
  );
}

function GhGroup({ title, count, nodes, status, empty }: {
  title: string; count?: number; nodes: GhNode[]; status: GhStatusMap; empty?: string;
}) {
  return (
    <Stack gap={5}>
      <Row className="mono" gap={6} style={{
        fontSize: 9.5, textTransform: "uppercase",
        letterSpacing: ".06em", color: "var(--fg-muted)",
      }}>
        <Box as="span">{title}</Box>
        {count !== undefined && <Text as="span" tone="dim">{count}</Text>}
      </Row>
      {nodes.length === 0
        ? <Text as="div" mono size={10} tone="dim" style={{ opacity: 0.6, paddingLeft: 19 }}>{empty}</Text>
        : (
          <Stack gap={3} style={{ paddingLeft: 8 }}>
            {nodes.map(n => (
              <GhItemRow key={n.id} node={n} state={status[n.id] ?? { status: "planned" }} />
            ))}
          </Stack>
        )
      }
    </Stack>
  );
}

// Repositories group: each repo row owns its phase tracking issues, indented
// beneath it with a connector so issue ownership is clear at a glance.
function GhReposGroup({ repos, status }: { repos: GhRepoNode[]; status: GhStatusMap }) {
  return (
    <Stack gap={5}>
      <Row className="mono" gap={6} style={{
        fontSize: 9.5, textTransform: "uppercase",
        letterSpacing: ".06em", color: "var(--fg-muted)",
      }}>
        <Box as="span">Repositories</Box>
        <Text as="span" tone="dim">{repos.length}</Text>
      </Row>
      {repos.length === 0
        ? <Text as="div" mono size={10} tone="dim" style={{ opacity: 0.6, paddingLeft: 19 }}>
            none linked — ask Claude to create or link repositories
          </Text>
        : (
          <Stack gap={8} style={{ paddingLeft: 8 }}>
            {repos.map(r => (
              <Stack key={r.node.id} gap={3}>
                <GhItemRow node={r.node} state={status[r.node.id] ?? { status: "planned" }} />
                {r.issues.length > 0 && (
                  <Stack gap={2} style={{
                    paddingLeft: 14, marginLeft: 5,
                    borderLeft: "1px solid var(--border-soft)",
                  }}>
                    {r.issues.map(iss => (
                      <GhItemRow key={iss.id} node={iss} state={status[iss.id] ?? { status: "planned" }} />
                    ))}
                  </Stack>
                )}
              </Stack>
            ))}
          </Stack>
        )
      }
    </Stack>
  );
}

export function GitHubStructureCard({ structure, status }: { structure: GhStructure; status: GhStatusMap }) {
  return (
    <Stack gap={12} style={{
      padding: "12px 14px", borderRadius: 6,
      background: "color-mix(in oklch, var(--info), transparent 92%)",
      border: "1px solid color-mix(in oklch, var(--info), transparent 70%)",
      flexShrink: 0,
    }}>
      <Text as="div" mono size={10} style={{
        color: "var(--info)", textTransform: "uppercase", letterSpacing: ".06em",
      }}>
        github structure
      </Text>
      <GhGroup title="Project board" nodes={[structure.project]} status={status} />
      <GhReposGroup repos={structure.repos} status={status} />
      {structure.streams.length > 0 && (
        <GhGroup
          title="Agents"
          count={structure.streams.length}
          nodes={structure.streams.map(s => ({ id: s.id, label: `${s.label} · stream:${s.id.replace(/^stream:/, "")}` }))}
          status={status}
        />
      )}
    </Stack>
  );
}
