// PipelinePage — the Pages-tier composition for LINKED-LIST-shaped data (#2505): a complete
// pipeline/workflow page built strictly from kit components. The Sequence template (#2477 — the
// ideal for prev→next-ordered data: the status-colored step strip with directional connectors)
// under a titled header bar, driving a focused-step DETAIL panel: the step's label + a status Chip,
// its description, and its facts as a KeyValueList. Pure/presentational — the ordered `steps`
// array in via props is the whole data source.
//
// Selection follows the house idiom via Sequence itself: controlled (`selectedId` + `onSelect`) or
// uncontrolled (`defaultSelectedId`, else auto-following the `active` step).
import type { ReactNode } from "react";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { Chip } from "@/shared/ui/data/Chip";
import { KeyValueList, type KeyValueItem } from "@/shared/ui/data/KeyValueList";
import { Sequence, type SequenceStep, type SequenceStatus } from "@/shared/ui/layouts/Sequence";
import { PageHeader } from "./pageHeader";

/** One pipeline step — a SequenceStep plus the detail panel's content. */
export interface PipelineStep extends SequenceStep {
  /** Prose under the step heading in the detail panel. */
  description?: ReactNode;
  /** The step's facts — rendered as the detail panel's KeyValueList. */
  facts?: KeyValueItem[];
}

export interface PipelinePageProps {
  /** Page title (the header bar). */
  title: ReactNode;
  /** Dimmed hint after the title. */
  hint?: ReactNode;
  /** Right-aligned header controls (actions). */
  toolbar?: ReactNode;
  /** The ordered steps — array order IS the pipeline order (prev → next). */
  steps: PipelineStep[];
  /** "horizontal" (default) → stepper strip above the detail; "vertical" → timeline rail beside it. */
  orientation?: "horizontal" | "vertical";
  /** Controlled focused step id (pair with onSelect). Omit for uncontrolled selection. */
  selectedId?: string;
  /** Uncontrolled initial focus — defaults to auto-following the active step, else the first. */
  defaultSelectedId?: string;
  /** Fires with the clicked step's id (both modes). */
  onSelect?: (id: string) => void;
  /** Detail panel override — a render fn of the focused step. Default: heading + status Chip +
   *  description + facts KeyValueList. */
  detail?: (step: PipelineStep) => ReactNode;
  /** Extra class on the root (a page scoping hook). */
  className?: string;
}

/** Step status → the detail Chip's semantic tone. */
const STATUS_TONE: Record<SequenceStatus, "success" | "accent" | "danger" | "neutral"> = {
  complete: "success", active: "accent", blocked: "danger", upcoming: "neutral",
};

export function PipelinePage({
  title, hint, toolbar,
  steps, orientation = "horizontal",
  selectedId, defaultSelectedId, onSelect,
  detail, className,
}: PipelinePageProps) {
  const defaultDetail = (step: PipelineStep): ReactNode => {
    const status = step.status ?? "upcoming";
    return (
      <Stack gap={12}>
        <Row gap={10}>
          <Text size="md" weight={600}>{step.label}</Text>
          <Chip tone={STATUS_TONE[status]} dot size="xs">{status}</Chip>
        </Row>
        {step.description != null && <Text size="sm" tone="muted" as="p" style={{ margin: 0, lineHeight: 1.5 }}>{step.description}</Text>}
        {step.facts && step.facts.length > 0 && <KeyValueList items={step.facts} />}
      </Stack>
    );
  };

  return (
    <Sequence
      className={className}
      steps={steps}
      orientation={orientation}
      selectedId={selectedId}
      defaultSelectedId={defaultSelectedId}
      onSelect={onSelect}
      toolbar={<PageHeader title={title} hint={hint} toolbar={toolbar} />}
      // Sequence resolves the focused step from `steps`, so it is one of OUR PipelineSteps.
      detail={(step) => detail?.(step as PipelineStep) ?? defaultDetail(step as PipelineStep)}
    />
  );
}
