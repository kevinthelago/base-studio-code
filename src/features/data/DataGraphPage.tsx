// The DATA GRAPH page (the-data-graph-a-global-third-pillar) — the third pillar beside Components and
// Algorithms, surfaced as a Planner tab.
//
// It reads the GLOBAL entity store (`bsc data entity list`), not a project's DuckDB. The distinction is
// the whole point of the pillar: the rest of `bsc data` is the canonical Data Model of the app being
// BUILT, scoped per project; this is the model of OUR OWN storage, scoped globally, exactly as
// `bsc ui` and `bsc graph` are global stores of our own library.
//
// The two facts on a row are the ones the other pillars could not express. `instances: single` says a
// live thing exists exactly once app-wide — which is what made the app store impossible to migrate as
// an ordinary record, since vendoring its source would build a second store with its own state,
// subscribers and persist. And `shape` is the EXISTING components↔data edge: `bsc ui shapes` maps a
// shape to the components ideal for rendering it, so setting one connects an entity to its UI with no
// new mechanism.
import { useEffect, useState } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { bscJson } from "@/shared/lib/core/bsc";

/** One entity in the global data graph — the frontend mirror of the Rust `Entity`. */
export interface DataEntity {
  id: string;
  name: string;
  summary?: string;
  shape?: string;
  fields?: string[];
  /** `single` = exactly one live instance app-wide; absent means `many`. */
  instances?: "single" | "many";
  src?: string;
  provides?: string;
}

/** Read the global entity store. Project-independent, so it takes no project key. */
export async function loadEntities(): Promise<DataEntity[]> {
  return bscJson<DataEntity[]>(null, ["data", "entity", "list"], []);
}

export function DataGraphPage() {
  const [entities, setEntities] = useState<DataEntity[] | null>(null);

  useEffect(() => {
    let alive = true;
    void loadEntities().then((e) => {
      if (alive) setEntities(e);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (entities && entities.length === 0) {
    return (
      <EmptyState
        title="No entities yet"
        description="The data graph is the global store of our own data model — add one with `bsc data entity set`."
      />
    );
  }

  return (
    <Box style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16 }}>
      <Stack gap={12}>
        <Stack gap={2}>
          <Text weight={600} size={15}>Data</Text>
          <Text size={12} tone="muted">
            The global data graph — our own entities, connected to components by shape and to algorithms
            by what they read and write.
          </Text>
        </Stack>

        {(entities ?? []).map((e) => (
          <Box
            key={e.id}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 12,
              background: "var(--bg-elev)",
            }}
          >
            <Stack gap={6}>
              <Row gap={8} align="center" style={{ minWidth: 0, flexWrap: "wrap" }}>
                <Text weight={600} size={13}>{e.name}</Text>
                <Text as="code" mono size={11} tone="dim">{e.id}</Text>
                {/* The fact no other pillar could state: there is exactly ONE of this at runtime. */}
                {e.instances === "single" && (
                  <Text as="code" mono size={10} tone="accent" style={{ textTransform: "uppercase" }}>
                    single instance
                  </Text>
                )}
                {e.shape && (
                  <Text as="code" mono size={10} tone="muted">shape: {e.shape}</Text>
                )}
              </Row>

              {e.summary && <Text size={12} tone="muted">{e.summary}</Text>}

              {!!e.fields?.length && (
                <Row gap={6} align="center" style={{ minWidth: 0, flexWrap: "wrap" }}>
                  <Eyebrow size={10}>Fields</Eyebrow>
                  {e.fields.slice(0, 12).map((f) => (
                    <Text key={f} as="code" mono size={11}>{f}</Text>
                  ))}
                  {e.fields.length > 12 && (
                    <Text size={11} tone="dim">+{e.fields.length - 12} more</Text>
                  )}
                </Row>
              )}

              {e.provides && (
                <Text as="code" mono size={11} tone="dim">{e.provides}</Text>
              )}
            </Stack>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}
