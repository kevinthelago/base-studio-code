// KitRenderer (#1852 Phase 2) — renders a declarative `KitNode` tree through the shared UI primitives,
// wiring each node's `bind` (a host state key a control reads/writes) and `action` (a host callback) to
// the values/handlers the host passes in. The agent authors the spec as data; the host owns the wiring —
// the agent never writes an onChange or an onClick. Switching the underlying kit/theme later is a
// renderer change here, never a change to the spec the agent emitted.

import type { ComponentType, ReactNode } from "react";
import { Card } from "@/shared/ui/data/Card";
import { TextField, SelectField } from "@/shared/ui/controls/Field";
import { Button } from "@/shared/ui/controls/Button";
import { Toggle } from "@/shared/ui/controls/Toggle";
import { Chip } from "@/shared/ui/data/Chip";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import type { Tone, TextSize } from "@/shared/ui/typography/type";
import { componentFor } from "@/shared/ui/registry";
import { UI_KIT } from "@/shared/ui/manifest";
import type { GeneralNode } from "./generalNode";
import type {
  KitNode, CardNode, HeaderNode, FieldNode, ButtonNode, RowNode, ToggleNode, TagNode, TextNode,
} from "./schema";

/** Primitive name → its manifest spec, for looking up a prop's declared TYPE at render time. */
const SPEC_BY_NAME = new Map(UI_KIT.map((p) => [p.name as string, p]));

/** A node-ish value: a general node (`type`) or a legacy kind node (`kind`). */
function isNodeLike(v: unknown): boolean {
  return (
    typeof v === "object" && v !== null && !Array.isArray(v) &&
    (typeof (v as Record<string, unknown>).type === "string" ||
      typeof (v as Record<string, unknown>).kind === "string")
  );
}

/** Render a slot value: a list of nodes, a single node, or plain text — mirroring what the validator
 *  accepts for a `node`-typed prop, so anything that validates also renders. */
function renderSlot(value: unknown, ctx: KitBindings, key: string): ReactNode {
  if (Array.isArray(value)) {
    return value.map((v, i) =>
      isNodeLike(v) ? renderNode(v as KitNode | GeneralNode, ctx, `${key}[${i}]`) : (v as ReactNode),
    );
  }
  if (isNodeLike(value)) return renderNode(value as KitNode | GeneralNode, ctx, key);
  return value as ReactNode;
}

/**
 * Render a GENERAL node by resolving its `type` through the registry (#3494) — no per-primitive branch.
 * Adding a primitive to the manifest makes it renderable here with no edit to this file.
 *
 * Props pass through except where the manifest declares their TYPE, which is how the renderer knows
 * what to do without guessing from names:
 * - `function` ⇒ the value is an ACTION NAME (the 3a contract), resolved against `ctx.on`. A data tree
 *   never carries a function, so this is the ONLY way a handler can arrive.
 * - `node` ⇒ a slot, rendered recursively.
 *
 * An unresolvable `type` renders a VISIBLE error rather than null: a silent blank in a data-driven UI
 * is indistinguishable from "the data said render nothing", which is precisely the failure this whole
 * migration must not introduce. It does not throw — that would white-screen a production surface over
 * one bad node.
 */
function renderGeneral(node: GeneralNode, ctx: KitBindings, key: string): ReactNode {
  const Comp = componentFor(node.type);
  if (!Comp) {
    return (
      <Text key={key} tone="danger" size="sm">
        {`[unknown primitive "${node.type}" — not in the UI registry]`}
      </Text>
    );
  }
  const spec = SPEC_BY_NAME.get(node.type);
  const props: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(node.props ?? {})) {
    const declared = spec?.props.find((p) => p.name === name);
    if (declared?.type === "function") {
      // The value is an action name; bind it to the host callback. An unknown name becomes a no-op
      // rather than a crash — the same tolerance the legacy `button` branch has always had.
      const action = typeof value === "string" ? value : "";
      props[name] = () => ctx.on?.[action]?.();
      continue;
    }
    if (declared?.type === "node") {
      props[name] = renderSlot(value, ctx, `${key}.${name}`);
      continue;
    }
    props[name] = value;
  }
  // The node-level actions map (#3496). Applied AFTER the declared-prop pass so it wins on a conflict:
  // it is the more explicit statement, and letting the implicit path override an explicit one would be
  // surprising precisely when an author is trying to be unambiguous. This is also the ONLY way to bind
  // a handler on a `passthrough` primitive (e.g. `Button.onClick`), whose handlers are undeclared.
  for (const [propName, actionName] of Object.entries(node.actions ?? {})) {
    props[propName] = () => ctx.on?.[actionName]?.();
  }

  // Node-level `children` is sugar for the `children` prop (the 3a normalisation) — resolve it here
  // too, so a tree that validates renders.
  const children =
    node.children !== undefined ? renderSlot(node.children, ctx, `${key}.children`) : props.children;
  delete props.children;
  const C = Comp as ComponentType<Record<string, unknown>>;
  return (
    <C key={key} {...props}>
      {children as ReactNode}
    </C>
  );
}

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
  /** The spec tree to render (typically the agent's emitted JSON, validated before rendering).
   *  Either vocabulary: a legacy `kind` node or a general `type` node (#3494). */
  node: KitNode | GeneralNode;
}

/** Render a node tree. `values`/`onBind`/`on` wire the spec's `bind`/`action` hooks to host state. */
export function KitRenderer({ node, values, onBind, on }: KitRendererProps) {
  return <>{renderNode(node, { values, onBind, on }, "$")}</>;
}

function renderNode(node: KitNode | GeneralNode, ctx: KitBindings, key: string): ReactNode {
  // Route by vocabulary (#3494), matching how `validate_spec` routes on the Rust side: a `type` node
  // resolves generically through the registry, a `kind` node takes the hand-written path below. Both
  // are valid input while they coexist — 3c deletes the kinds, and this dispatch with them.
  if (!("kind" in node) || typeof (node as KitNode).kind !== "string") {
    return renderGeneral(node as GeneralNode, ctx, key);
  }
  switch ((node as KitNode).kind) {
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
