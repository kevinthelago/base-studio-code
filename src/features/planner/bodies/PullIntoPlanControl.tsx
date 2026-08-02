// The "pull into plan" control (#4267) — pick which feature is built from this library record.
//
// Rendered INTO each library lens as a render prop, so the lenses stay agnostic about what pulling
// means and neither feature imports the other's UI: the planner owns the plan, the lenses own their
// library. `PlannerLibraryPane` supplies it; a lens rendered anywhere else simply gets no control.
//
// Append-only by design — see `pullIntoPlan.ts`: the feature upsert cannot express an empty `requires`,
// so a remove action would silently no-op on the last item.
import { useState } from "react";
import type { PlanFeature } from "@/features/planner/issues/featureList";
import { featureRequires, pullIntoPlan } from "@/features/planner/lib/pullIntoPlan";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";

export interface PullIntoPlanControlProps {
  /** The project whose plan.db receives the edge. */
  projectKey: string;
  /** The plan's features — the pull targets. */
  features: PlanFeature[];
  /** The library record being pulled (`merge-sort.rs`, a component id). */
  artifactId: string;
}

export function PullIntoPlanControl({ projectKey, features, artifactId }: PullIntoPlanControlProps) {
  // Ids pulled in THIS session, so the chip reads as required immediately rather than after the next
  // plan poll. The store stays the source of truth; this is only the optimistic overlay.
  const [pulled, setPulled] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (features.length === 0) {
    return (
      <Text tone="dim" size={10.5}>
        No features yet — the plan needs a capability before a library record can be attached to one.
      </Text>
    );
  }

  const pull = async (feature: PlanFeature) => {
    setError(null);
    setBusy(feature.slug);
    try {
      await pullIntoPlan(projectKey, feature, artifactId);
      setPulled((s) => new Set(s).add(feature.slug));
    } catch (e) {
      // The defect this control replaces was a toast that reported success without writing. A failed
      // write says so.
      setError(`Couldn't record it on “${feature.name}” — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack gap={4}>
      <Text tone="dim" size={10.5}>Build a feature from this — the worker gets the id, not a copy</Text>
      <Row gap={4} wrap>
        {features.map((f) => {
          const already = featureRequires(f, artifactId) || pulled.has(f.slug);
          return (
            <Button
              key={f.slug}
              size="sm"
              variant={already ? "default" : "ghost"}
              disabled={already || busy === f.slug}
              onClick={() => void pull(f)}
              title={already ? `“${f.name}” already requires ${artifactId}` : `Build “${f.name}” from ${artifactId}`}
            >
              {already ? "✓ " : "+ "}{f.name}
            </Button>
          );
        })}
      </Row>
      {error && <Text tone="danger" size={10.5}>{error}</Text>}
    </Stack>
  );
}
