import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Text } from "@/shared/ui/typography/Text";
import type { Filters, StateFilter, SortKey } from "./issuesModel";

export function FilterBar({
  filters, onChange, labels, milestones, total, shown,
}: {
  filters: Filters;
  onChange: (f: Partial<Filters>) => void;
  labels: string[];
  milestones: string[];
  total: number;
  shown: number;
}) {
  const stateOpts: { k: StateFilter; label: string }[] = [
    { k: "all",    label: "all"    },
    { k: "open",   label: "open"   },
    { k: "closed", label: "closed" },
  ];

  const selectStyle = {
    height: 26, fontSize: 10.5,
    fontFamily: "var(--mono)", background: "var(--bg-elev)",
    border: "1px solid var(--border-soft)", borderRadius: 4,
    color: "var(--fg-muted)", padding: "0 6px", cursor: "pointer",
  };

  return (
    <Row gap={8} wrap style={{
      padding: "10px 16px", borderBottom: "1px solid var(--border-soft)",
      background: "var(--bg-panel)",
    }}>
      {/* eslint-disable-next-line no-restricted-syntax -- inline fixed-width filter box in a toolbar Row; TextField's .field wrapper doesn't fit */}
      <input
        className="input"
        placeholder="⌕ filter issues…"
        value={filters.search}
        onChange={e => onChange({ search: e.target.value })}
        style={{ height: 26, width: 220, fontSize: 11 }}
      />

      <Row gap={1} align="stretch" style={{ borderRadius: 4, overflow: "hidden", border: "1px solid var(--border-soft)" }}>
        {stateOpts.map(({ k, label }) => (
          // eslint-disable-next-line no-restricted-syntax -- bespoke segmented state-filter buttons with joined borders and active-state styling, not a .btn control
          <button
            key={k}
            onClick={() => onChange({ state: k })}
            className="mono"
            style={{
              height: 26, padding: "0 10px",
              fontSize: 10.5,
              background: filters.state === k ? "var(--bg-elev2)" : "var(--bg-elev)",
              border: "none", borderRight: k !== "closed" ? "1px solid var(--border-soft)" : "none",
              color: filters.state === k ? "var(--fg)" : "var(--fg-muted)",
              cursor: "pointer",
            }}
          >{label}</button>
        ))}
      </Row>

      {labels.length > 0 && (
        // eslint-disable-next-line no-restricted-syntax -- bespoke inline mono toolbar dropdown (shared selectStyle, no label); SelectField's labelled .field wrapper doesn't fit
        <select
          style={selectStyle}
          value={filters.label}
          onChange={e => onChange({ label: e.target.value })}
        >
          <option value="">label: all</option>
          {labels.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      )}

      {milestones.length > 0 && (
        // eslint-disable-next-line no-restricted-syntax -- bespoke inline mono toolbar dropdown (shared selectStyle, no label); SelectField's labelled .field wrapper doesn't fit
        <select
          style={selectStyle}
          value={filters.milestone}
          onChange={e => onChange({ milestone: e.target.value })}
        >
          <option value="">milestone: all</option>
          {milestones.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      )}

      <Spacer />

      <Text mono size={10.5} tone="dim">
        {shown === total ? `${total} issues` : `${shown} of ${total}`}
      </Text>

      {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline mono toolbar dropdown (shared selectStyle, no label); SelectField's labelled .field wrapper doesn't fit */}
      <select
        style={selectStyle}
        value={filters.sort}
        onChange={e => onChange({ sort: e.target.value as SortKey })}
      >
        <option value="newest">sort: newest</option>
        <option value="oldest">oldest</option>
        <option value="number">number ↓</option>
        <option value="comments">most comments</option>
      </select>
    </Row>
  );
}
