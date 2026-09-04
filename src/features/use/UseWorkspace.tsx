// The USE layer's screen — what this app has FINISHED, and what can be driven now.
//
// The third rail destination for the third layer. The STORE layer (Components, Algorithms, Sounds,
// Data) is what the app builds FROM; the BUILD layer (Glance) is what it is building; this is what it
// has built. It sits beside Glance in the rail because the two are read together.
//
// IT READS `bsc capability`, NEVER ITS OWN QUERY, and that is the load-bearing constraint rather than
// a tidiness preference. The same read serializes as the CONTEXT a network's steward session gets, so
// a capability this screen calls stale cannot reach the model as current. Give the screen its own
// query and the two drift — which is exactly how `docs/llm-operator/context.md` came to point a local
// model at a dead host for seven weeks while looking authoritative.
//
// FRESHNESS IS RENDERED, not assumed. Every row shows the state the READ decided to present, which for
// anything past its budget is `unknown` rather than its last value.
import { useCallback, useEffect, useState } from "react";
import { Boxes, RefreshCw } from "lucide-react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { bscJson } from "@/shared/lib/core/bsc";

/** One network's line in the picker — mirrors `bsc capability networks`. */
export interface NetworkRow {
  network: string;
  projects: number;
  capabilities: number;
}

/** A capability, as `bsc capability get --json` serialises it. */
export interface CapabilityRow {
  id: string;
  kind: string;
  name: string;
  how: string;
  observed: { state: string; at_ms?: number };
}

export interface NetworkCapabilities {
  network: string;
  projects: { project: string; capabilities: CapabilityRow[] }[];
  shared: CapabilityRow[];
}

/** The budget the Rust side uses (`freshness::DEFAULT_BUDGET_MS`). Mirrored, and pinned by a test —
 *  a screen that believed a reading longer than the read does would render stale state as current. */
export const BUDGET_MS = 5 * 60 * 1000;

/** What to SHOW for one capability. The same rule `freshness::presented_state` applies, because a
 *  renderer that is more generous than the reader is how a stale value reaches a person as a fact. */
export function presented(obs: CapabilityRow["observed"], now: number, budget = BUDGET_MS): string {
  if (obs.at_ms === undefined || obs.at_ms === null) return "unknown (never observed)";
  if (now - obs.at_ms > budget) return "unknown (stale)";
  return obs.state;
}

/** Is this reading believable right now? Drives the visual treatment, so stale LOOKS stale. */
export function isFresh(obs: CapabilityRow["observed"], now: number, budget = BUDGET_MS): boolean {
  return obs.at_ms !== undefined && obs.at_ms !== null && now - obs.at_ms <= budget;
}

/** Flatten to rows, shared first — the same order `NetworkCapabilities::rows` produces. */
export function flatten(c: NetworkCapabilities | null): { project: string; cap: CapabilityRow }[] {
  if (!c) return [];
  return [
    ...c.shared.map((cap) => ({ project: "", cap })),
    ...c.projects.flatMap((p) => p.capabilities.map((cap) => ({ project: p.project, cap }))),
  ];
}

export function UseWorkspace() {
  const [networks, setNetworks] = useState<NetworkRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [caps, setCaps] = useState<NetworkCapabilities | null>(null);
  const [loading, setLoading] = useState(false);
  // Held in state and refreshed on load, so a row's freshness is judged against WHEN WE LOOKED rather
  // than against render time — otherwise a screen left open silently ages its own data into "stale"
  // without ever having re-read it, which is a different (and misleading) claim.
  const [readAt, setReadAt] = useState(() => Date.now());

  const loadNetworks = useCallback(async () => {
    const rows = await bscJson<NetworkRow[]>(null, ["capability", "networks", "--json"], []);
    setNetworks(rows);
    setSelected((s) => s ?? rows[0]?.network ?? null);
  }, []);

  const loadCaps = useCallback(async (net: string) => {
    setLoading(true);
    try {
      const c = await bscJson<NetworkCapabilities | null>(null, ["capability", "get", net, "--json"], null);
      setCaps(c);
      setReadAt(Date.now());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadNetworks(); }, [loadNetworks]);
  useEffect(() => { if (selected) void loadCaps(selected); }, [selected, loadCaps]);

  const rows = flatten(caps);

  return (
    <Stack style={{ flex: 1, minHeight: 0, padding: 16, gap: 12 }}>
      <Row style={{ alignItems: "center", gap: 10 }}>
        <Boxes size={18} />
        <Text weight={600} size={15}>Use</Text>
        <Text size={12} style={{ color: "var(--fg-muted)" }}>
          what this app has finished, and what can be driven now
        </Text>
        <Box style={{ flex: 1 }} />
        <Button
          variant="ghost"
          onClick={() => { void loadNetworks(); if (selected) void loadCaps(selected); }}
          aria-label="refresh"
        >
          <RefreshCw size={14} />
        </Button>
      </Row>

      {networks.length > 0 && (
        <Row style={{ gap: 6, flexWrap: "wrap" }}>
          {networks.map((n) => (
            <Button
              key={n.network}
              variant={n.network === selected ? "primary" : "ghost"}
              onClick={() => setSelected(n.network)}
            >
              {n.network} · {n.capabilities}
            </Button>
          ))}
        </Row>
      )}

      {networks.length === 0 && !loading && (
        // An EXPLAINED empty. "No networks" and "the read failed" look identical otherwise, and the
        // person would not know which they are looking at.
        <EmptyState
          title="No network owns a project yet"
          description="A network is a domain that owns projects together. Assign one with `bsc project network set <project> <network>`."
        />
      )}

      {selected && rows.length === 0 && !loading && (
        <EmptyState
          title={`${selected} exposes no capabilities yet`}
          description="Nothing it owns is deployed or published. That is an answer, not a failure — there is nothing here to drive."
        />
      )}

      {rows.length > 0 && (
        <Stack style={{ gap: 2, overflowY: "auto", minHeight: 0 }}>
          {rows.map(({ project, cap }) => {
            const fresh = isFresh(cap.observed, readAt);
            return (
              <Row
                key={cap.id}
                data-capability={cap.id}
                style={{
                  gap: 12, padding: "6px 8px", alignItems: "center",
                  borderBottom: "1px solid var(--border-soft)",
                  // Stale LOOKS stale. A uniform row would make an unknown reading as visually
                  // authoritative as a current one, which is the whole failure being designed against.
                  opacity: fresh ? 1 : 0.55,
                }}
              >
                <Text size={12} style={{ width: 150, color: "var(--fg-muted)" }}>{project || "—"}</Text>
                <Text size={13} weight={500} style={{ width: 160 }}>{cap.name}</Text>
                <Text size={11} style={{ width: 70, color: "var(--fg-muted)" }}>{cap.kind}</Text>
                <Text size={12} style={{ color: fresh ? "var(--fg)" : "var(--graph-health-warn, var(--fg-muted))" }}>
                  {presented(cap.observed, readAt)}
                </Text>
                <Box style={{ flex: 1 }} />
                <Text size={11} style={{ fontFamily: "var(--font-mono)", color: "var(--fg-muted)" }}>{cap.how}</Text>
              </Row>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
