// Design Studio preview fixtures (#2555) — render the REAL `shared/ui` components in the preview,
// not the hand-drawn mocks in `specimens.tsx`. Each fixture instantiates the actual component (the same
// one the app renders) with representative props/children per variant, so the Studio is true WYSIWYG:
// what you preview is exactly what ships, themed through the same tokens (the caller wraps the result in
// <ThemeScope>). A fixture returns `null` for a variant it doesn't cover, so the caller falls back to the
// `specimens.tsx` mock — letting us port the catalogue incrementally before deleting the mocks.
//
// These are keyed by `PrimitiveName` and looked up through the same `registry.tsx` name-space the kit
// uses everywhere; adding coverage is adding a real-component render here, never a new mock.
import type { ReactNode } from "react";
import type { PrimitiveName } from "@/shared/ui/manifest";
import { Box } from "@/shared/ui/layout/Box";
import { Button } from "@/shared/ui/controls/Button";
import { Toggle } from "@/shared/ui/controls/Toggle";
import { Checkbox } from "@/shared/ui/controls/Checkbox";
import { TextField } from "@/shared/ui/controls/Field";
import { Card } from "@/shared/ui/data/Card";
import { Chip } from "@/shared/ui/data/Chip";
import { StatTile } from "@/shared/ui/data/StatTile";
import { Code } from "@/shared/ui/data/Code";
import { FillBar } from "@/shared/ui/data/FillBar";
import { Banner } from "@/shared/ui/feedback/Banner";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { InlineError } from "@/shared/ui/feedback/InlineError";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
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
  Toggle: (v) => <Toggle on onClick={noop} tone={v === "success" ? "success" : "accent"} />,
  Checkbox: () => <Checkbox checked onChange={noop} aria-label="preview" />,
  TextField: (v) =>
    frame(240, <TextField label="Stage name" value={v === "loading" ? "" : "auth-service"} onChange={noop} loading={v === "loading"} placeholder="name…" />),
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
  Banner: (v) => {
    const tone = BANNER_TONES.has(v) ? (v as "neutral" | "info" | "success" | "warn" | "danger" | "accent") : "neutral";
    return frame(320, <Banner tone={tone} dot>Fleet is building — 3 streams active.</Banner>);
  },
  EmptyState: (v) =>
    frame(300, <EmptyState icon="◇" title="No streams yet" description="Plan a fleet to populate this board." variant={v === "card" ? "card" : "inline"} size={v === "sm" ? "sm" : "md"} />),
  InlineError: () => frame(300, <InlineError>Gate blocked — resolve the dependency cycle.</InlineError>),
  StatusDot: (v) => <StatusDot color={v === "success" ? "var(--success)" : v === "danger" ? "var(--danger)" : "var(--accent)"} size={9} pulse={v !== "danger"} />,
  Text: (v) => v === "loading" ? frame(220, <Text loading />) : <Text weight={600}>The quick brown fox jumps</Text>,
};
