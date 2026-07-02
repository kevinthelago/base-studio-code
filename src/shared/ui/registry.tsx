// registry.tsx — the runtime render-map for the UI kit (#2060). Maps each `PrimitiveName` from the
// data manifest (`manifest.ts`) back to its actual component, so a builder/renderer can turn a
// manifest node (`{ type: "Row", props: {…} }`) into real JSX. Kept separate from `manifest.ts` so
// the manifest stays pure, serialisable data.
//
// Typed as `Record<PrimitiveName, …>`: adding a name to `PrimitiveName` without a row here (or a
// stale row) is a COMPILE error — that's what keeps the manifest and the render-map in lock-step.

import type { ComponentType } from "react";
import type { PrimitiveName } from "./manifest";

import { Box } from "./layout/Box";
import { Stack } from "./layout/Stack";
import { Row } from "./layout/Row";
import { Spacer } from "./layout/Spacer";
import { Grid } from "./layout/Grid";
import { Text } from "./typography/Text";
import { Button } from "./controls/Button";
import { IconButton } from "./controls/IconButton";
import { Checkbox } from "./controls/Checkbox";
import { Toggle } from "./controls/Toggle";
import { SegmentedControl } from "./controls/SegmentedControl";
import { TextField, SelectField } from "./controls/Field";
import { Card } from "./data/Card";
import { Chip } from "./data/Chip";
import { StatTile } from "./data/StatTile";
import { FillBar } from "./data/FillBar";
import { Banner } from "./feedback/Banner";
import { EmptyState } from "./feedback/EmptyState";
import { StatusDot } from "./feedback/StatusDot";

// Heterogeneous prop shapes — a render-map is intentionally prop-agnostic.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

/** name → component for every primitive in the manifest. The `Record<PrimitiveName>` type enforces
 *  exhaustive, in-sync coverage at compile time. */
export const UI_COMPONENTS: Record<PrimitiveName, AnyComponent> = {
  Box, Stack, Row, Spacer, Grid,
  Text,
  Button, IconButton, Checkbox, Toggle, SegmentedControl, TextField, SelectField,
  Card, Chip, StatTile, FillBar,
  Banner, EmptyState, StatusDot,
};

/** Resolve a primitive name to its component (undefined for an unknown name). */
export function componentFor(name: PrimitiveName): AnyComponent | undefined {
  return UI_COMPONENTS[name];
}
