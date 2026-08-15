// registry.tsx — the runtime render-map for the UI kit (#2060). Maps each `PrimitiveName` from the
// data manifest (`manifest.ts`) back to its actual component, so a builder/renderer can turn a
// manifest node (`{ type: "Row", props: {…} }`) into real JSX. Kept separate from `manifest.ts` so
// the manifest stays pure, serialisable data.
//
// Typed as `Record<PrimitiveName, …>`: adding a name to `PrimitiveName` without a row here (or a
// stale row) is a COMPILE error — that's what keeps the manifest and the render-map in lock-step.

import type { ComponentType } from "react";
import type { PrimitiveName } from "@/shared/ui/manifest";

import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
// `@/` form, not `./layout/Spacer`: the module is RETIRED and now resolves through the record
// fallback, which matches on the alias. A relative specifier bypasses that and finds nothing.
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Slot } from "./layout/Slot";
import { Grid } from "@/shared/ui/layout/Grid";
import { SectionHeader } from "@/shared/ui/layout/SectionHeader";
import { SectionLabel } from "@/shared/ui/layout/SectionLabel";
import { Dialog } from "./overlay/Dialog";
import { ModalScrim } from "./overlay/ModalScrim";
import { ModalCard } from "./overlay/ModalCard";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { Checkbox } from "@/shared/ui/controls/Checkbox";
import { Toggle } from "@/shared/ui/controls/Toggle";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";
import { TextField, TextArea, SelectField } from "@/shared/ui/controls/Field";
import { Option } from "./controls/Option";
import { BackButton } from "@/shared/ui/controls/BackButton";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { ConfirmButton } from "@/shared/ui/controls/ConfirmButton";
import { Card } from "@/shared/ui/data/Card";
import { Chip } from "@/shared/ui/data/Chip";
import { StatTile } from "@/shared/ui/data/StatTile";
import { FillBar } from "@/shared/ui/data/FillBar";
import { Code } from "@/shared/ui/data/Code";
import { Avatar } from "@/shared/ui/data/Avatar";
import { IconBox } from "@/shared/ui/data/IconBox";
import { CardListRow } from "@/shared/ui/data/CardListRow";
import { DataTableRow } from "@/shared/ui/data/DataTableRow";
import { RoleTierChips } from "@/shared/ui/data/RoleTierChips";
import { StatCard } from "./charts/primitives";
import { LineArea, Bars, Donut, HBars, Swimlane, Spark, Legend, StackedDayBars } from "./charts/Charts";
import { Banner } from "@/shared/ui/feedback/Banner";
import { InlineError } from "@/shared/ui/feedback/InlineError";
// #4172 — failure containment, composable from a spec.
import { PageBoundary } from "@/shared/ui/layouts/PageBoundary";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { Skeleton } from "@/shared/ui/feedback/Skeleton";
import { MasterDetail } from "@/shared/ui/layouts/MasterDetail";
import { SplitView } from "@/shared/ui/layouts/SplitView";
import { GraphCanvas } from "./layouts/GraphCanvas";
import { PaneGrid } from "@/shared/ui/layouts/PaneGrid";
import { Sequence } from "@/shared/ui/layouts/Sequence";
import { Tree } from "@/shared/ui/layouts/Tree";
// #2421 gap-fill
import { LabelChip } from "./data/LabelChip";
import { ActivityFeed } from "@/shared/ui/data/ActivityFeed";
import { Pane } from "@/shared/ui/overlay/Pane";
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
