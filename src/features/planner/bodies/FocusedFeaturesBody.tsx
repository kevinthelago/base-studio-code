// The Features board (split from FocusedBodies.tsx #1757): one card per user-facing capability the
// planner has written to features.json, with a defined/drafting badge + its owning stream. The
// "easy way" the user curates and watches each feature take shape.
import { useExpandable } from "@/shared/hooks/useExpandable";
import { Tile } from "@/features/planner/pane/focusedPrimitives";
import { featureDefined, type PlanFeature } from "@/features/planner/issues/featureList";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Box } from "@/shared/ui/layout/Box";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";

export function FeaturesBody({ features }: { features?: PlanFeature[] }) {
  const list = features ?? [];
  // Auto-expand the first not-yet-defined feature — the one the workshop is actively driving down.
  const firstDrafting = list.find((f) => !featureDefined(f))?.slug;
  const { open, toggle } = useExpandable(firstDrafting ? [firstDrafting] : []);

  if (list.length === 0) {
    return <EmptyState iconVariant="dashed" icon="◇" title="No features yet — Claude proposes a starter set you curate" />;
  }

  const definedCount = list.filter(featureDefined).length;

  return (
    <Box className="features-view">
      <Box className="tiles">
        <Tile v={list.length} k="features" />
        <Tile v={definedCount} k="defined" />
        <Tile v={list.length - definedCount} k="drafting" />
      </Box>
      {list.map((f) => {
        const done = featureDefined(f);
        const acc = f.acceptance ?? [];
        // The workshop drills each feature down to: behavior + acceptance, build approach, tools,
        // data + deps. A card is expandable once it carries any of that detail.
        const hasDetail = !!(f.approach || f.data || (f.tools && f.tools.length > 0) || acc.length > 0);
        const isOpen = open.has(f.slug);
        return (
          <Box
            key={f.slug}
            className={"feature-card" + (done ? " done" : "") + (isOpen ? " open" : "")}
            onClick={hasDetail ? () => toggle(f.slug) : undefined}
            style={{ cursor: hasDetail ? "pointer" : "default" }}
          >
            <Box className="feature-head">
              <Box as="span" className="feature-caret">{hasDetail ? (isOpen ? "▼" : "▶") : ""}</Box>
              <Box as="span" className="sdot" bg={done ? "var(--success)" : "var(--fg-dim)"} />
              <Box as="span" className="feature-name">{f.name}</Box>
              <Spacer />
              <Box as="span" className={"feature-badge" + (done ? " done" : "")}>{done ? "✓ defined" : "○ drafting"}</Box>
            </Box>
            {f.behavior && <Box className="feature-behavior">{f.behavior}</Box>}

            {isOpen ? (
              <Box
                className="feature-detail"
                onClick={(e) => e.stopPropagation()}
                style={{ cursor: "default" }}
              >
                {f.approach && (
                  <Box className="feature-field">
                    <Box as="span" className="feature-flabel">approach</Box>
                    <Box as="span" className="feature-ftext">{f.approach}</Box>
                  </Box>
                )}
                {f.tools && f.tools.length > 0 && (
                  <Box className="feature-field">
                    <Box as="span" className="feature-flabel">tools</Box>
                    <Box as="span" className="feature-tools">{f.tools.map((t) => <Box as="span" key={t} className="chip">{t}</Box>)}</Box>
                  </Box>
                )}
                {f.data && (
                  <Box className="feature-field">
                    <Box as="span" className="feature-flabel">data + deps</Box>
                    <Box as="span" className="feature-ftext">{f.data}</Box>
                  </Box>
                )}
                {acc.length > 0 && (
                  <Box className="feature-field col">
                    <Box as="span" className="feature-flabel">acceptance criteria</Box>
                    <Box className="feature-acc">
                      {acc.map((a, i) => (
                        <Box key={i} className="feature-acc-item">
                          <Box as="span" className="feature-acc-box" />
                          <Box as="span">{a}</Box>
                        </Box>
                      ))}
                    </Box>
                  </Box>
                )}
              </Box>
            ) : (
              acc.length > 0 && (
                <Box className="feature-acc-count">
                  {acc.length} acceptance {acc.length === 1 ? "criterion" : "criteria"}
                </Box>
              )
            )}
          </Box>
        );
      })}
    </Box>
  );
}
