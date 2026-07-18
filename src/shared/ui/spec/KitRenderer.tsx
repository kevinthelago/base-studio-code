// KitRenderer (#1852 Phase 2) — renders a declarative `KitNode` tree through the shared UI primitives,
// wiring each node's `bind` (a host state key a control reads/writes) and `action` (a host callback) to
// the values/handlers the host passes in. The agent authors the spec as data; the host owns the wiring —
// the agent never writes an onChange or an onClick. Switching the underlying kit/theme later is a
// renderer change here, never a change to the spec the agent emitted.

import type { ReactNode } from "react";
import { Card } from "@/shared/ui/data/Card";
import { TextField, SelectField } from "@/shared/ui/controls/Field";
import { Button } from "@/shared/ui/controls/Button";
import { Toggle } from "@/shared/ui/controls/Toggle";
import { Chip } from "@/shared/ui/data/Chip";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import type { Tone, TextSize } from "@/shared/ui/typography/type";
import type {
  KitNode, CardNode, HeaderNode, FieldNode, ButtonNode, RowNode, ToggleNode, TagNode, TextNode,
} from "./schema";

/** The host-supplied wiring a rendered spec binds to. */
export interface KitBindings {
  /** Current host state, keyed by a node's `bind`. */
  values?: Record<string, unknown>;
  /** Called when a bound control changes — the host writes the value back into its own state. */
  onBind?: (bind: string, value: unknown) => void;
  /** Host callbacks, keyed by a node's `action` (fired by button clicks). */
  on?: Record<string, () => void>;
}

export interface KitRendererProps extends KitBindings {
  /** The spec tree to render (typically the agent's emitted JSON, validated via `validateKitNode`). */
  node: KitNode;
}

/** Render a `KitNode` tree. `values`/`onBind`/`on` wire the spec's `bind`/`action` hooks to host state. */
export function KitRenderer({ node, values, onBind, on }: KitRendererProps) {
  return <>{renderNode(node, { values, onBind, on }, "$")}</>;
}

function renderNode(node: KitNode, ctx: KitBindings, key: string): ReactNode {
  switch (node.kind) {
    case "card": {
      const c = node as CardNode;
      return (
        <Card
          key={key}
          tone={c.tone}
          title={c.header ? undefined : c.title}
          hint={c.header ? undefined : c.hint}
          header={c.header ? renderNode(c.header, ctx, `${key}.header`) : undefined}
        >
          <Stack gap="sm">{c.children.map((ch, i) => renderNode(ch, ctx, `${key}.c${i}`))}</Stack>
        </Card>
      );
    }
    case "header": {
      const h = node as HeaderNode;
      return (
        <Row key={key} gap="sm" align="baseline">
          <Text size="md" weight={600}>{h.title}</Text>
          {h.hint != null && <Text tone="dim" size="sm">{h.hint}</Text>}
        </Row>
      );
    }
    case "field": {
      const f = node as FieldNode;
      const val = String(ctx.values?.[f.bind ?? ""] ?? "");
      const set = (v: string) => { if (f.bind) ctx.onBind?.(f.bind, v); };
      if (f.control === "select") {
        return (
          <SelectField key={key} label={f.label} hint={f.hint} value={val} onChange={set}>
            {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </SelectField>
        );
      }
      return (
        <TextField
          key={key}
          label={f.label}
          hint={f.hint}
          value={val}
          onChange={set}
          type={f.control === "password" ? "password" : (f.inputType ?? "text")}
          placeholder={f.placeholder}
        />
      );
    }
    case "button": {
      const b = node as ButtonNode;
      return (
        <Button
          key={key}
          variant={b.variant}
          danger={b.danger}
          onClick={() => { if (b.action) ctx.on?.[b.action]?.(); }}
        >
          {b.label}
        </Button>
      );
    }
    case "row": {
      const r = node as RowNode;
      return (
        <Row key={key} gap="sm" justify="between">
          {r.label != null && <Text>{r.label}</Text>}
          <Row gap="sm">{r.children.map((ch, i) => renderNode(ch, ctx, `${key}.c${i}`))}</Row>
        </Row>
      );
    }
    case "toggle": {
      const t = node as ToggleNode;
      const isOn = Boolean(ctx.values?.[t.bind]);
      // role="switch" + aria-checked make the spec-rendered toggle an accessible (and testable) switch.
      const sw = <Toggle key={key} on={isOn} role="switch" ariaChecked={isOn} onClick={() => ctx.onBind?.(t.bind, !isOn)} />;
      if (t.label == null) return sw;
      return <Row key={key} gap="sm" justify="between"><Text>{t.label}</Text>{sw}</Row>;
    }
    case "tag": {
      const t = node as TagNode;
      return <Chip key={key} tone={t.tone ?? "neutral"}>{t.label}</Chip>;
    }
    case "text": {
      const t = node as TextNode;
      return <Text key={key} tone={t.tone as Tone | undefined} size={t.size as TextSize | undefined}>{t.text}</Text>;
    }
    default:
      return null;
  }
}
