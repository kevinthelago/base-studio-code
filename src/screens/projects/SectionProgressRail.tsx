// SectionProgressRail — v4 node-based section progress rail (#668).
// Renders each planning section as a small node with:
//   confirmed  → solid green node, solid green connector
//   now        → pulsing accent node (the active/current section)
//   banked     → green-ringed dashed node + "banked" tooltip (drafted ahead)
//   pending    → dim node, dashed connector
import type { Section } from "./ghStructure";
import { parseSectionKey, titleForKey } from "./planSections";
import type { SectionState } from "./ghStructure";

type RailNodeState = "confirmed" | "now" | "banked" | "pending";

function getRailNodeState(s: Section, idx: number, all: Section[]): RailNodeState {
  if (s.state === "confirmed") return "confirmed";
  if (s.state === "pending") return "pending";
  // drafted: banked if any pending section precedes this one (written out of order)
  const hasPendingBefore = all.slice(0, idx).some(p => p.state === "pending");
  return hasPendingBefore ? "banked" : "now";
}

function getConnectorVariant(
  left: RailNodeState,
  right: RailNodeState,
): "solid-green" | "solid-accent" | "dashed-green" | "dashed" {
  if (left === "confirmed" && right === "confirmed") return "solid-green";
  if (left === "confirmed" && (right === "now" || right === "banked")) return "solid-accent";
  if (left === "banked" || right === "banked") return "dashed-green";
  return "dashed";
}

function RailNode({
  nodeState,
  title,
  isBanked,
}: {
  nodeState: RailNodeState;
  title: string;
  isBanked: boolean;
}) {
  const base: React.CSSProperties = {
    width: 7, height: 7, borderRadius: "50%",
    flex: "0 0 7px", display: "inline-block", position: "relative",
  };

  // No initializer: every switch branch below (incl. default) assigns `style`, so the
  // `{ ...base }` seed was dead (eslint no-useless-assignment). (#741)
  let style: React.CSSProperties;
  let className = "rail-node";

  switch (nodeState) {
    case "confirmed":
      style = { ...base, background: "var(--success)" };
      break;
    case "now":
      style = { ...base, background: "var(--accent)" };
      className += " rail-node-now";
      break;
    case "banked":
      style = {
        ...base,
        background: "color-mix(in oklch, var(--success), transparent 80%)",
        border: "1.5px dashed color-mix(in oklch, var(--success), transparent 20%)",
        boxSizing: "border-box",
      };
      break;
    case "pending":
    default:
      style = {
        ...base,
        background: "var(--bg-elev2)",
        border: "1px solid var(--border-soft)",
        boxSizing: "border-box",
      };
      break;
  }

  return (
    <span
      className={className}
      style={style}
      title={isBanked ? `${title} (banked — drafted ahead)` : title}
    />
  );
}

function Connector({ variant }: { variant: ReturnType<typeof getConnectorVariant> }) {
  const base: React.CSSProperties = {
    flex: 1,
    height: 1,
    margin: "0 1px",
    alignSelf: "center",
  };

  switch (variant) {
    case "solid-green":
      return <span style={{ ...base, background: "var(--success)" }} />;
    case "solid-accent":
      return <span style={{ ...base, background: "var(--accent)" }} />;
    case "dashed-green":
      return <span style={{ ...base, borderTop: "1px dashed color-mix(in oklch, var(--success), transparent 40%)" }} />;
    case "dashed":
    default:
      return <span style={{ ...base, borderTop: "1px dashed var(--border-soft)" }} />;
  }
}

function GroupDivider() {
  return (
    <span style={{
      flex: "0 0 auto", width: 1, height: 9, borderRadius: 1,
      background: "var(--border)", alignSelf: "center", margin: "0 3px",
    }} />
  );
}

interface SectionGroup {
  repo?: string;
  keys: string[];
}

export function SectionProgressRail({
  projectKeys,
  repoGroups,
  sectionByKey,
}: {
  projectKeys: string[];
  repoGroups: SectionGroup[];
  sectionByKey: Map<string, Section>;
}) {
  // Build flat ordered section list across project + all repos
  const allKeys = [...projectKeys, ...repoGroups.flatMap(g => g.keys)];
  const allSections: Section[] = allKeys.map(k =>
    sectionByKey.get(k) ?? {
      k, title: titleForKey(k), state: "pending" as SectionState, content: "",
    },
  );

  if (allSections.length === 0) return null;

  const nodeStates: RailNodeState[] = allSections.map((s, i) =>
    getRailNodeState(s, i, allSections),
  );

  const confirmedCount = nodeStates.filter(s => s === "confirmed").length;
  const nowCount       = nodeStates.filter(s => s === "now").length;
  const bankedCount    = nodeStates.filter(s => s === "banked").length;

  // Build render elements: nodes + connectors + group dividers
  const elements: React.ReactNode[] = [];
  let flatIdx = 0;

  const groups: SectionGroup[] = [
    { keys: projectKeys },
    ...repoGroups,
  ];

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    if (gi > 0) elements.push(<GroupDivider key={`div-${gi}`} />);

    for (let ki = 0; ki < group.keys.length; ki++) {
      const k    = group.keys[ki];
      const s    = allSections[flatIdx];
      const ns   = nodeStates[flatIdx];
      const info = parseSectionKey(k);
      const label = info.tier === "repo"
        ? `${info.repo} · ${titleForKey(k)}`
        : titleForKey(k);

      elements.push(
        <RailNode
          key={k}
          nodeState={ns}
          title={label}
          isBanked={ns === "banked"}
        />,
      );

      // Connector to next node (within the same group only — divider handles group gaps)
      const nextFlatIdx = flatIdx + 1;
      const isLastInGroup = ki === group.keys.length - 1;
      if (!isLastInGroup && nextFlatIdx < nodeStates.length) {
        const connVariant = getConnectorVariant(ns, nodeStates[nextFlatIdx]);
        elements.push(<Connector key={`conn-${k}`} variant={connVariant} />);
      }

      void s; // s is used via allSections for getRailNodeState
      flatIdx++;
    }
  }

  return (
    <div style={{
      padding: "10px 24px 8px",
      display: "flex",
      gap: 0,
      alignItems: "center",
    }}>
      {elements}

      {/* Summary pill — compact stats */}
      <span style={{
        marginLeft: 10, flex: "0 0 auto",
        display: "inline-flex", gap: 5, alignItems: "center",
        fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--fg-dim)",
      }}>
        <span style={{ color: "var(--success)" }}>{confirmedCount}✓</span>
        {nowCount > 0 && (
          <span style={{ color: "var(--accent)" }}>·{nowCount} active</span>
        )}
        {bankedCount > 0 && (
          <span style={{
            color: "var(--success)",
            background: "color-mix(in oklch, var(--success), transparent 88%)",
            border: "1px dashed color-mix(in oklch, var(--success), transparent 40%)",
            borderRadius: 4, padding: "0 4px",
          }}>
            {bankedCount} banked
          </span>
        )}
      </span>

      <style>{`
        .rail-node-now {
          animation: rail-pulse 1.8s ease-in-out infinite;
        }
        @keyframes rail-pulse {
          0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--accent), transparent 60%); }
          50%       { box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent), transparent 88%); }
        }
      `}</style>
    </div>
  );
}
