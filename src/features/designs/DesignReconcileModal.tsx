// The blueprint-download reconciliation confirm-list (#2658, epic #2606 slice 5b-3) — the ALERT the
// maintainer chose over lazy/eager reconciliation: when a downloaded blueprint introduces design
// categories the local contract doesn't define (reconcileDesign, #2646), this offers to fill them with
// coherent generated colours and register them as a runtime CONTRIBUTION (compose-don't-mutate, #2650),
// so a shared blueprint brings its look with NO holes — without editing the shared contract.
//
// ⭐ FALL LOUDLY: a generator failure shows an error banner (not a silent no-op), and Skip records a WARN
// — the gap remains and is observable later. Silent failure is the enemy.
import { useState } from "react";
import { Sparkles, AlertTriangle, Loader2, ArrowRight } from "lucide-react";
import { useAppStore } from "@/store";
import { contributionFromCategories } from "@/shared/ui/kit";
import { log } from "@/shared/lib/core/log";
import { Dialog } from "@/shared/ui/overlay/Dialog";
import { Button } from "@/shared/ui/controls/Button";
import { Banner } from "@/shared/ui/feedback/Banner";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { generateCategoryColors } from "./lib/designGenBridge";

export interface DesignReconcileModalProps {
  /** Provenance — the blueprint id whose download triggered this; the contribution's `source` so a later
   *  removal drops exactly its overlay. */
  source: string;
  /** The blueprint's display name, for the copy. */
  label: string;
  /** The categories the blueprint introduces that the contract doesn't define (reconcileDesign). */
  missingCategories: string[];
  /** A theme the blueprint prefers (`bsc ui theme` id), surfaced as info; applying it is separate. */
  themeRef?: string;
  /** Close the modal — called after a successful apply AND on skip/dismiss. */
  onClose: () => void;
}

/** Offer to fill a downloaded blueprint's missing design categories via the generator, then register the
 *  result as a design contribution. Self-contained: owns the generate→apply interaction + the loud
 *  failure surface; the parent only mounts it with the reconcile result. */
export function DesignReconcileModal({ source, label, missingCategories, themeRef, onClose }: DesignReconcileModalProps) {
  const addDesignContribution = useAppStore((s) => s.addDesignContribution);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const n = missingCategories.length;

  async function applyGenerated() {
    setBusy(true);
    setError(null);
    try {
      const colors = await generateCategoryColors(missingCategories);
      addDesignContribution(contributionFromCategories(source, colors));
      log.info(`design: generated ${n} categor${n === 1 ? "y" : "ies"} for “${label}” (${missingCategories.join(", ")})`, "design");
      onClose();
    } catch (e) {
      // Fall LOUDLY — the generator (the no-holes guarantee) is unreachable; surface it instead of
      // registering a partial/empty contribution.
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`design: colour generation failed for “${label}” — ${msg}`, "design");
      setError(`Couldn't generate colours — ${msg}. The design system's generator (bsc ui) may be unavailable. Nothing was applied.`);
    } finally {
      setBusy(false);
    }
  }

  function skip() {
    // The gap remains — make it observable rather than swallowing it (fall loudly).
    log.warn(`design: skipped ${n} unmapped categor${n === 1 ? "y" : "ies"} from “${label}” (${missingCategories.join(", ")}) — they will render without a bound colour`, "design");
    onClose();
  }

  return (
    <Dialog
      title="New design categories"
      onDismiss={busy ? () => {} : skip}
      actions={
        <>
          <Button variant="ghost" onClick={skip} disabled={busy}>Skip</Button>
          <Button variant="primary" onClick={() => void applyGenerated()} disabled={busy || n === 0}>
            {busy ? <><Loader2 size={13} style={{ animation: "bim-spin .8s linear infinite" }} />generating…</> : <><Sparkles size={13} />Generate &amp; apply</>}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Text as="div" size={12} tone="muted" style={{ lineHeight: 1.6 }}>
          <b style={{ color: "var(--fg)" }}>{label}</b> introduces {n} design categor{n === 1 ? "y" : "ies"} the design
          system doesn't define yet. Generate coherent colours for {n === 1 ? "it" : "them"} so the blueprint's
          look renders with no holes — this adds a removable overlay and never edits the shared contract.
        </Text>

        {error && (
          <Banner role="alert" tone="danger" lead={<AlertTriangle size={14} style={{ flex: "0 0 auto" }} />} onDismiss={() => setError(null)}>
            <Box as="span" style={{ flex: 1, color: "var(--fg)" }}>{error}</Box>
          </Banner>
        )}

        <Stack gap={6}>
          {missingCategories.map((c) => (
            <Row key={c} gap={9} className="mono" style={{
              padding: "7px 10px", background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
              borderRadius: "var(--r-md)", fontSize: 11.5,
            }}>
              <StatusDot size={7} color="var(--accent)" />
              <Box as="span" style={{ color: "var(--fg)" }}>{c}</Box>
              <Box as="span" style={{ flex: 1 }} />
              <Row gap={5} style={{ fontSize: 10, color: "var(--fg-dim)" }}>
                --graph-category-{c}<ArrowRight size={11} />colour
              </Row>
            </Row>
          ))}
        </Stack>

        {themeRef && (
          <Text as="div" size={10.5} tone="dim" className="mono" style={{ lineHeight: 1.5 }}>
            prefers theme <b style={{ color: "var(--fg-muted)" }}>{themeRef}</b> — pick it in Settings → Appearance to match fully
          </Text>
        )}
      </Stack>
    </Dialog>
  );
}
