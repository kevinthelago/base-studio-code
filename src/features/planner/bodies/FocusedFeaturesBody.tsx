// The Features board (split from FocusedBodies.tsx #1757): one card per user-facing capability the
// planner has written to features.json, with a defined/drafting badge + its owning stream. The
// "easy way" the user curates and watches each feature take shape.
import { useExpandable } from "@/shared/hooks/useExpandable";
import { Tile } from "@/features/planner/pane/focusedPrimitives";
import { featureDefined, type PlanFeature } from "@/features/planner/issues/featureList";
import { Spacer } from "@/shared/ui/layout/Spacer";

export function FeaturesBody({ features }: { features?: PlanFeature[] }) {
  const list = features ?? [];
  // Auto-expand the first not-yet-defined feature — the one the workshop is actively driving down.
  const firstDrafting = list.find((f) => !featureDefined(f))?.slug;
  const { open, toggle } = useExpandable(firstDrafting ? [firstDrafting] : []);

  if (list.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon">◇</span>
        <span>No features yet — Claude proposes a starter set you curate</span>
      </div>
    );
  }

  const definedCount = list.filter(featureDefined).length;

  return (
    <div className="features-view">
      <div className="tiles">
        <Tile v={list.length} k="features" />
        <Tile v={definedCount} k="defined" />
        <Tile v={list.length - definedCount} k="drafting" />
      </div>
      {list.map((f) => {
        const done = featureDefined(f);
        const acc = f.acceptance ?? [];
        // The workshop drills each feature down to: behavior + acceptance, build approach, tools,
        // data + deps. A card is expandable once it carries any of that detail.
        const hasDetail = !!(f.approach || f.data || (f.tools && f.tools.length > 0) || acc.length > 0);
        const isOpen = open.has(f.slug);
        return (
          <div
            key={f.slug}
            className={"feature-card" + (done ? " done" : "") + (isOpen ? " open" : "")}
            onClick={hasDetail ? () => toggle(f.slug) : undefined}
            style={{ cursor: hasDetail ? "pointer" : "default" }}
          >
            <div className="feature-head">
              <span className="feature-caret">{hasDetail ? (isOpen ? "▼" : "▶") : ""}</span>
              <span className="sdot" style={{ background: done ? "var(--success)" : "var(--fg-dim)" }} />
              <span className="feature-name">{f.name}</span>
              <Spacer />
              <span className={"feature-badge" + (done ? " done" : "")}>{done ? "✓ defined" : "○ drafting"}</span>
            </div>
            {f.behavior && <div className="feature-behavior">{f.behavior}</div>}

            {isOpen ? (
              <div
                className="feature-detail"
                onClick={(e) => e.stopPropagation()}
                style={{ cursor: "default" }}
              >
                {f.approach && (
                  <div className="feature-field">
                    <span className="feature-flabel">approach</span>
                    <span className="feature-ftext">{f.approach}</span>
                  </div>
                )}
                {f.tools && f.tools.length > 0 && (
                  <div className="feature-field">
                    <span className="feature-flabel">tools</span>
                    <span className="feature-tools">{f.tools.map((t) => <span key={t} className="chip">{t}</span>)}</span>
                  </div>
                )}
                {f.data && (
                  <div className="feature-field">
                    <span className="feature-flabel">data + deps</span>
                    <span className="feature-ftext">{f.data}</span>
                  </div>
                )}
                {acc.length > 0 && (
                  <div className="feature-field col">
                    <span className="feature-flabel">acceptance criteria</span>
                    <div className="feature-acc">
                      {acc.map((a, i) => (
                        <div key={i} className="feature-acc-item">
                          <span className="feature-acc-box" />
                          <span>{a}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              acc.length > 0 && (
                <div className="feature-acc-count">
                  {acc.length} acceptance {acc.length === 1 ? "criterion" : "criteria"}
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
