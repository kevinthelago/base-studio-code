// Design Studio preview fixtures (#2555, extended #2820) — render the REAL components in the preview,
// not the hand-drawn mocks in `specimens.tsx`. Each fixture instantiates the actual component (the same
// one the app renders) with representative props/children per variant, so the Studio is true WYSIWYG:
// what you preview is exactly what ships, themed through the same tokens (the caller wraps the result in
// <ThemeScope>). A react-ui fixture returns `null` for a variant it doesn't cover, so the caller falls
// back to the `specimens.tsx` mock — the incremental-port seam (#2555); once a component is fully
// covered here, its mock case is deleted.
//
// `SPECIMEN_FIXTURES` is keyed by `PrimitiveName` (the react-ui kit); `KIT_FIXTURES` holds real renders
// for OTHER kits' components (e.g. the d3 `ForceGraph`, #2820) whose names aren't manifest primitives.
// `previewFixture(name, variant)` is the single lookup both preview surfaces call.
import type { ReactNode } from "react";
import type { PrimitiveName } from "@/shared/ui/manifest";
import type { GhLabel } from "@/shared/lib/github/types";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Button } from "@/shared/ui/controls/Button";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { Toggle } from "@/shared/ui/controls/Toggle";
import { Checkbox } from "@/shared/ui/controls/Checkbox";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";
import { TextField, TextArea, SelectField } from "@/shared/ui/controls/Field";
import { BackButton } from "@/shared/ui/controls/BackButton";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { ConfirmButton } from "@/shared/ui/controls/ConfirmButton";
import { Card } from "@/shared/ui/data/Card";
import { Chip } from "@/shared/ui/data/Chip";
import { StatTile } from "@/shared/ui/data/StatTile";
import { Code } from "@/shared/ui/data/Code";
import { FillBar } from "@/shared/ui/data/FillBar";
import { Avatar } from "@/shared/ui/data/Avatar";
import { IconBox } from "@/shared/ui/data/IconBox";
import { RoleTierChips } from "@/shared/ui/data/RoleTierChips";
import { LabelChip } from "@/shared/ui/data/LabelChip";
import { KeyValueList } from "@/shared/ui/data/KeyValueList";
import { Banner } from "@/shared/ui/feedback/Banner";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { InlineError } from "@/shared/ui/feedback/InlineError";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { Skeleton } from "@/shared/ui/feedback/Skeleton";
import { StatCard } from "@/shared/ui/charts/primitives";
import { Bars, Donut, HBars } from "@/shared/ui/charts/Charts";
import { ForceGraph, type ForceGraphNode, type ForceGraphLink } from "@/shared/ui/charts/ForceGraph";
import { Text } from "@/shared/ui/typography/Text";

const noop = () => {};

/** A fixed-width preview wrapper so full-width components (Card/Banner/…) frame nicely in the pane.
 *  A plain helper (not a component) so this module exports only the fixtures object. */
const frame = (w: number, children: ReactNode): ReactNode => <Box style={{ width: w }}>{children}</Box>;

/** Chip/Banner tones the preview maps directly; anything else falls to the component default. */
const CHIP_TONES = new Set(["neutral", "accent", "success", "info", "danger"]);
const BANNER_TONES = new Set(["neutral", "info", "success", "warn", "danger", "accent"]);

/** name → (variant) → a REAL-component render, or null to defer to the `specimens.tsx` mock. */
export const SPECIMEN_FIXTURES: Partial<Record<PrimitiveName, (variant: string) => ReactNode>> = {
  Button: (v) => {
    if (v === "loading") return null;
    if (v === "primary") return <Button variant="primary">Launch stage</Button>;
    if (v === "ghost") return <Button variant="ghost">Cancel</Button>;
    if (v === "danger") return <Button danger>Delete</Button>;
    if (v === "sm") return <Button size="sm">clone</Button>;
    return <Button>Button</Button>;
  },
  IconButton: () => (
    <Row gap={8}>
      <IconButton aria-label="Close" danger />
      <IconButton aria-label="More">⋯</IconButton>
      <IconButton aria-label="Refresh">⟳</IconButton>
    </Row>
  ),
  Toggle: (v) => <Toggle on onClick={noop} tone={v === "success" ? "success" : "accent"} />,
  Checkbox: () => <Checkbox checked onChange={noop} aria-label="preview" />,
  SegmentedControl: (v) => (
    <SegmentedControl
      variant={v === "joined" ? "joined" : "padded"}
      options={[
        { label: "dark", on: true, onClick: noop },
        { label: "light", on: false, onClick: noop },
      ]}
    />
  ),
  TextField: (v) =>
    frame(240, <TextField label="Stage name" value={v === "loading" ? "" : "auth-service"} onChange={noop} loading={v === "loading"} placeholder="name…" />),
  TextArea: (v) =>
    frame(240, <TextArea label="Kickoff prompt" value={v === "loading" ? "" : "Work the assigned issue in your\nworktree, then open a PR and stop."} onChange={noop} loading={v === "loading"} rows={3} />),
  SelectField: () =>
    frame(240, (
      <SelectField label="Model" value="opus" onChange={noop}>
        <option value="opus">claude-opus-4-8</option>
        <option value="sonnet">claude-sonnet-5</option>
      </SelectField>
    )),
  BackButton: (v) => <BackButton onClick={noop} aria-label="Back to library" label="Back to library" variant={v === "icon" ? "icon" : "text"} />,
  ColorSwatch: () => (
    <Row gap={8}>
      {["--accent", "--success", "--danger", "--info", "--state-wait"].map((c) => (
        <ColorSwatch key={c} color={`var(${c})`} size={26} radius={7} />
      ))}
    </Row>
  ),
  ConfirmButton: () => <ConfirmButton label="Delete" armedLabel="Confirm?" onConfirm={noop} />,
  Card: (v) => {
    if (v === "loading") return frame(250, <Card loading>{null}</Card>);
    return frame(250, (
      <Card title="Auth service" hint="stream · 3 issues" interactive={v === "interactive"} onClick={v === "interactive" ? noop : undefined}>
        <Text tone="muted" size="sm">Owns the login + session surface.</Text>
      </Card>
    ));
  },
  Chip: (v) => {
    if (v === "loading") return null;
    const tone = CHIP_TONES.has(v) ? (v as "neutral" | "accent" | "success" | "info" | "danger") : "neutral";
    return <Chip tone={tone}>{v === "danger" ? "blocked" : "label"}</Chip>;
  },
  StatTile: (v) =>
    v === "loading"
      ? <StatTile k="throughput" v="" loading />
      : <StatTile k="throughput" v="42" sub="issues/day" tone={v === "danger" || v === "success" || v === "accent" ? v : undefined} />,
  Code: (v) => v === "loading" ? frame(260, <Code loading />) : <Code>{"bsc ui theme set --id ocean"}</Code>,
  FillBar: (v) => frame(220, v === "loading" ? <FillBar value={0} loading /> : <FillBar value={0.62} />),
  Avatar: () => (
    <Row gap={8}>
      {["ariadne", "kevin", "dvorak"].map((l) => <Avatar key={l} login={l} size={30} bordered />)}
    </Row>
  ),
  IconBox: () => (
    <Row gap={10}>
      {([["✦", "var(--accent)"], ["◫", "var(--fg-muted)"], ["⚙", "var(--fg-muted)"]] as const).map(([g, c]) => (
        <IconBox key={g} size={34} radius={9} background="var(--bg-elev)" color={c} border="1px solid var(--border-soft)" fontSize={15}>{g}</IconBox>
      ))}
    </Row>
  ),
  RoleTierChips: () => frame(240, <RoleTierChips role="worker" />),
  LabelChip: () => (
    <Row gap={8} wrap>
      {([{ name: "bug", color: "d73a4a" }, { name: "enhancement", color: "a2eeef" }, { name: "stream:api", color: "0e8a16" }] as GhLabel[]).map((l) => (
        <LabelChip key={l.name} label={l} />
      ))}
    </Row>
  ),
  KeyValueList: () =>
    frame(250, <KeyValueList labelWidth={90} items={[
      { k: "repo", v: "base-studio-code" },
      { k: "branch", v: "develop" },
      { k: "streams", v: "4 active" },
      { k: "plan.db", v: "~/.base-studio-code" },
    ]} />),
  Banner: (v) => {
    const tone = BANNER_TONES.has(v) ? (v as "neutral" | "info" | "success" | "warn" | "danger" | "accent") : "neutral";
    return frame(320, <Banner tone={tone} dot>Fleet is building — 3 streams active.</Banner>);
  },
  EmptyState: (v) =>
    frame(300, <EmptyState icon="◇" title="No streams yet" description="Plan a fleet to populate this board." variant={v === "card" ? "card" : "inline"} />),
  InlineError: () => frame(300, <InlineError>Gate blocked — resolve the dependency cycle.</InlineError>),
  StatusDot: (v) => <StatusDot color={v === "success" ? "var(--success)" : v === "danger" ? "var(--danger)" : "var(--accent)"} size={9} pulse={v !== "danger"} />,
  Skeleton: () => (
    <Box style={{ display: "flex", flexDirection: "column", gap: 9, width: 240 }}>
      <Skeleton w="60%" h={10} />
      <Skeleton h={10} />
      <Skeleton w="85%" h={10} />
    </Box>
  ),
  StatCard: (v) =>
    frame(160, v === "loading"
      ? <StatCard k="Landed today" v="" loading />
      : <StatCard k="Landed today" v="12" tone="success" delta={{ dir: "up", text: "4 vs yesterday" }} />),
  Bars: () =>
    frame(300, <Bars height={120} labels={["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]} groups={[
      { name: "landed", color: "var(--success)", data: [3, 5, 4, 6, 5, 7] },
      { name: "opened", color: "var(--accent)", data: [4, 3, 5, 4, 6, 5] },
    ]} />),
  Donut: () =>
    <Donut center={{ value: "62%", label: "done" }} slices={[
      { name: "landed", value: 62, color: "var(--success)" },
      { name: "active", value: 22, color: "var(--accent)" },
      { name: "blocked", value: 16, color: "var(--danger)" },
    ]} />,
  HBars: () =>
    frame(220, <HBars rows={[
      { label: "bsc-deny", value: 72, color: "var(--accent)" },
      { label: "bsc-scope", value: 41 },
      { label: "bsc-audit", value: 18 },
    ]} />),
  Text: (v) => v === "loading" ? frame(220, <Text loading />) : <Text weight={600}>The quick brown fox jumps</Text>,
};

// ── other-kit fixtures (#2820) — real renders for components whose names aren't react-ui primitives ──
const D3_NODES: ForceGraphNode[] = [
  { id: "core", label: "core", group: 0 },
  { id: "api", label: "api", group: 1 },
  { id: "ui", label: "ui", group: 2 },
  { id: "db", label: "db", group: 0 },
  { id: "auth", label: "auth", group: 3 },
  { id: "relay", label: "relay", group: 1 },
  { id: "cli", label: "cli", group: 4 },
];
const D3_LINKS: ForceGraphLink[] = [
  { source: "core", target: "api" },
  { source: "core", target: "ui" },
  { source: "api", target: "db" },
  { source: "api", target: "auth" },
  { source: "ui", target: "auth" },
  { source: "core", target: "relay" },
  { source: "cli", target: "core" },
  { source: "relay", target: "api" },
];

/** name → real render for non-manifest kits (the d3 kit's `ForceGraph`, #2820). */
const KIT_FIXTURES: Record<string, (variant: string) => ReactNode> = {
  ForceGraph: () => <ForceGraph nodes={D3_NODES} links={D3_LINKS} />,
};

/** The single preview lookup both surfaces call: the REAL-component render for `name`/`variant`, or
 *  `null` to fall back to the `specimens.tsx` mock (an uncovered variant, or an unknown component). */
export function previewFixture(name: string, variant: string): ReactNode | null {
  const fx = (SPECIMEN_FIXTURES as Record<string, (v: string) => ReactNode>)[name] ?? KIT_FIXTURES[name];
  return fx ? fx(variant) : null;
}
