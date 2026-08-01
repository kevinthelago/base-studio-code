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
import { Slot } from "./layout/Slot";
import { Grid } from "./layout/Grid";
import { SectionHeader } from "./layout/SectionHeader";
import { SectionLabel } from "./layout/SectionLabel";
import { Dialog } from "./overlay/Dialog";
import { ModalScrim } from "./overlay/ModalScrim";
import { ModalCard } from "./overlay/ModalCard";
import { Text } from "./typography/Text";
import { Button } from "./controls/Button";
import { IconButton } from "./controls/IconButton";
import { Checkbox } from "./controls/Checkbox";
import { Toggle } from "./controls/Toggle";
import { SegmentedControl } from "./controls/SegmentedControl";
import { TextField, TextArea, SelectField } from "./controls/Field";
import { Option } from "./controls/Option";
import { BackButton } from "./controls/BackButton";
import { ColorSwatch } from "./controls/ColorSwatch";
import { ConfirmButton } from "./controls/ConfirmButton";
import { Card } from "./data/Card";
import { Chip } from "./data/Chip";
import { StatTile } from "./data/StatTile";
import { FillBar } from "./data/FillBar";
import { Code } from "./data/Code";
import { Avatar } from "./data/Avatar";
import { IconBox } from "./data/IconBox";
import { CardListRow } from "./data/CardListRow";
import { DataTableRow } from "./data/DataTableRow";
import { RoleTierChips } from "./data/RoleTierChips";
import { StatCard } from "./charts/primitives";
import { LineArea, Bars, Donut, HBars, Swimlane, Spark, Legend, StackedDayBars } from "./charts/Charts";
import { Banner } from "./feedback/Banner";
import { InlineError } from "./feedback/InlineError";
// #4172 — failure containment, composable from a spec.
import { PageBoundary } from "./layouts/PageBoundary";
import { EmptyState } from "./feedback/EmptyState";
import { StatusDot } from "./feedback/StatusDot";
import { Skeleton } from "./feedback/Skeleton";
import { MasterDetail } from "./layouts/MasterDetail";
import { SplitView } from "./layouts/SplitView";
import { GraphCanvas } from "./layouts/GraphCanvas";
import { PaneGrid } from "./layouts/PaneGrid";
import { Sequence } from "./layouts/Sequence";
import { Tree } from "./layouts/Tree";
// #2421 gap-fill
import { LabelChip } from "./data/LabelChip";
import { ActivityFeed } from "./data/ActivityFeed";
import { Pane } from "./overlay/Pane";
import { TelemetryPanel, ItemBars, SplitBar } from "./charts/telemetry";
// #2475 — the key-value record rendering
import { KeyValueList } from "./data/KeyValueList";
// #2505 — the Pages tier (complete data-driven page compositions)
import { TablePage } from "./pages/TablePage";
import { TreeExplorerPage } from "./pages/TreeExplorerPage";
import { PipelinePage } from "./pages/PipelinePage";
import { NetworkPage } from "./pages/NetworkPage";
import { DashboardPage } from "./pages/DashboardPage";
import { CollectionPage } from "./pages/CollectionPage";
// #2508 — the key-value shape's page, completing the page-per-shape set
import { RecordPage } from "./pages/RecordPage";

// Heterogeneous prop shapes — a render-map is intentionally prop-agnostic.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

/** name → component for every primitive in the manifest. The `Record<PrimitiveName>` type enforces
 *  exhaustive, in-sync coverage at compile time. */
export const UI_COMPONENTS: Record<PrimitiveName, AnyComponent> = {
  Box, Stack, Row, Spacer, Slot, Grid, SectionHeader, SectionLabel, Dialog, ModalScrim, ModalCard,
  Text,
  Button, IconButton, Checkbox, Toggle, SegmentedControl, TextField, TextArea, SelectField, Option,
  BackButton, ColorSwatch, ConfirmButton,
  Card, Chip, StatTile, FillBar, Code,
  Avatar, IconBox, CardListRow, DataTableRow, RoleTierChips,
  StatCard, LineArea, Bars, Donut, HBars, Swimlane, Spark, Legend, StackedDayBars,
  Banner, InlineError, EmptyState, StatusDot, Skeleton, PageBoundary,
  MasterDetail, SplitView, GraphCanvas, PaneGrid, Sequence, Tree,
  LabelChip, ActivityFeed, Pane, TelemetryPanel, ItemBars, SplitBar,
  KeyValueList,
  TablePage, TreeExplorerPage, PipelinePage, NetworkPage, DashboardPage, CollectionPage, RecordPage,
};

/** Resolve a primitive name to its component (undefined for an unknown name). */
export function componentFor(name: PrimitiveName): AnyComponent | undefined {
  return UI_COMPONENTS[name];
}
