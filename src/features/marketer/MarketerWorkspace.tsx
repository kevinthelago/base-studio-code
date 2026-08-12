import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/store";
import { useMarketerStore } from "./store";
import { ContentDrawer } from "./ContentDrawer";
import { resolveAllInstalledMcp } from "@/features/mcp";
import { deriveChannelViews, type ChannelView } from "./lib/channels";
import { contentForCampaign, type ContentStatus } from "./lib/campaign";
import { summarizeMetrics, fmtMetric, fmtChannelReadout, type ChannelMetricsReadout } from "./lib/metrics";
import { fetchChannelMetrics } from "./lib/api";
import { Screen } from "@/shared/ui/layouts/Screen";
import { usePageTabs } from "@/shared/hooks/usePageTabs";
import type { TabItem } from "@/shared/ui/layouts/TabBar";
import { Card } from "@/shared/ui/data/Card";
import { CardListRow } from "@/shared/ui/data/CardListRow";
import { SectionHeader } from "@/shared/ui/layout/SectionHeader";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Chip } from "@/shared/ui/data/Chip";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { Button } from "@/shared/ui/controls/Button";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

const STATUS_TONE: Record<ContentStatus, "neutral" | "accent" | "success" | "info"> = {
  draft: "neutral", approved: "info", scheduled: "accent", published: "success",
};

/** The Marketer feature's page shell (#3148/#3149, epic #3145) — Campaigns (the draft→approve→
 *  schedule→publish loop), Channels (read-only status over the mcp feature's catalog, #3146), and
 *  Analytics (the read-back, #3149). Not yet mounted to a rail Workspace or Settings page — that
 *  wiring is a director-owned integration step; this export is the feature's public surface, ready
 *  for it. */
export function MarketerWorkspace({ pageOverride }: { pageOverride?: string } = {}) {
  const campaigns = useMarketerStore((s) => s.campaigns);
  const contentItems = useMarketerStore((s) => s.contentItems);
  const addCampaign = useMarketerStore((s) => s.addCampaign);
  const addContentItem = useMarketerStore((s) => s.addContentItem);
  const updateContentItem = useMarketerStore((s) => s.updateContentItem);
  const approveContentItem = useMarketerStore((s) => s.approveContentItem);
  const scheduleContentItem = useMarketerStore((s) => s.scheduleContentItem);
  const publishContentItem = useMarketerStore((s) => s.publishContentItem);

  const mcpServers = useAppStore((s) => s.mcpServers);
  const activeProjectId = useAppStore((s) => s.activeProjectId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const selected = contentItems.find((i) => i.id === selectedId) ?? null;

  const channels = useMemo(() => deriveChannelViews(resolveAllInstalledMcp(mcpServers)), [mcpServers]);
  const summary = useMemo(() => summarizeMetrics(contentItems), [contentItems]);

  const defs: TabItem[] = useMemo(() => [
    { id: "campaigns", label: "Campaigns", count: campaigns.length },
    { id: "channels", label: "Channels", count: channels.length },
    { id: "analytics", label: "Analytics" },
  ], [campaigns.length, channels.length]);
  const { tabs, activeId, select, reorder, tearOff } = usePageTabs("marketer", defs);
  const tab = pageOverride ?? activeId;

  function createDraft(campaignId: string) {
    // A single channel server (e.g. the built-in mock) can carry either shape of send — email vs
    // social is a property of the DRAFT, not of which server backs it — so default to "email" (the
    // richer, compliance-gated case) and let the drawer switch it before approval.
    const first = channels[0];
    const id = addContentItem({
      campaignId,
      channel: first?.name ?? "Channel (mock)",
      channelKind: "email",
      body: "",
    });
    setSelectedId(id);
  }

  async function handlePublish() {
    if (!selected) return;
    setPublishing(true);
    try {
      await publishContentItem(selected.id, activeProjectId ?? "");
    } finally {
      setPublishing(false);
    }
  }

  function campaignsView() {
    if (campaigns.length === 0) {
      return (
        <EmptyState
          title="No campaigns yet"
          description="Campaigns ground in the market-research stage's findings — draft one to start the publish loop."
          actions={<Button variant="primary" onClick={() => addCampaign("New campaign")}>+ New campaign</Button>}
        />
      );
    }
    return (
      <Stack gap={14}>
        <SectionHeader title="Campaigns" meta={<>{campaigns.length} campaign{campaigns.length === 1 ? "" : "s"}</>} right={<Button variant="ghost" onClick={() => addCampaign("New campaign")}>+ New campaign</Button>} />
        {campaigns.map((c) => {
          const items = contentForCampaign(contentItems, c.id);
          return (
            <Card key={c.id} title={c.name} hint={c.researchRef?.gap ? `grounded in: ${c.researchRef.gap}` : undefined}
              right={<Button variant="ghost" size="sm" onClick={() => createDraft(c.id)}>+ draft</Button>}>
              {items.length === 0 ? (
                <Box className="hint">no drafts yet</Box>
              ) : (
                <Stack gap={6}>
                  {items.map((i) => (
                    <CardListRow
                      key={i.id}
                      lead={<StatusDot color={i.status === "published" ? "var(--success)" : i.status === "draft" ? "var(--fg-dim)" : "var(--accent)"} />}
                      title={i.channel}
                      badge={<Chip tone={STATUS_TONE[i.status]}>{i.status}</Chip>}
                      subtitle={i.subject || i.body.slice(0, 80) || "(empty draft)"}
                      trailing={<Button variant="ghost" size="sm" onClick={() => setSelectedId(i.id)}>open</Button>}
                      onClick={() => setSelectedId(i.id)}
                    />
                  ))}
                </Stack>
              )}
            </Card>
          );
        })}
      </Stack>
    );
  }

  function channelsView() {
    return (
      <Stack gap={10}>
        <SectionHeader title="Channels" hint="a marketing channel is an MCP server (#3146) — connect/assign one from the MCP page" meta={<>{channels.length} known</>} />
        {channels.length === 0 ? (
          <EmptyState
            title="No channels yet"
            description="Add a channel MCP server from the MCP catalog (e.g. the built-in mock channel), then assign it to the marketer stream."
          />
        ) : (
          <Stack gap={6}>
            {channels.map((c) => (
              <CardListRow
                key={c.id}
                lead={<StatusDot color={c.installed ? "var(--success)" : "var(--fg-dim)"} />}
                title={c.name}
                badge={<Chip tone="info">{c.kind}</Chip>}
                subtitle={c.installed ? "installed" : "not installed — add it from the MCP catalog"}
                trailing={c.assigned ? <Chip tone="success">assigned to marketer</Chip> : <Chip>not assigned</Chip>}
              />
            ))}
          </Stack>
        )}
      </Stack>
    );
  }

  return (
    <Screen
      tabs={tabs}
      active={tab}
      onSelect={select}
      onReorder={reorder}
      onTearOff={tearOff}
      pageOverride={pageOverride}
      className="marketer-workspace"
      overlay={
        <ContentDrawer
          item={selected}
          onClose={() => setSelectedId(null)}
          onPatch={(patch) => selected && updateContentItem(selected.id, patch)}
          onApprove={() => (selected ? approveContentItem(selected.id) : { ok: false })}
          onSchedule={(whenIso) => selected && scheduleContentItem(selected.id, whenIso)}
          onPublish={handlePublish}
          publishing={publishing}
        />
      }
    >
      {tab === "channels" ? channelsView() : tab === "analytics" ? (
        <AnalyticsView summary={summary} channels={channels} project={activeProjectId ?? ""} />
      ) : campaignsView()}
    </Screen>
  );
}

function AnalyticsView({ summary, channels, project }: { summary: ReturnType<typeof summarizeMetrics>; channels: ChannelView[]; project: string }) {
  const [readouts, setReadouts] = useState<Record<string, ChannelMetricsReadout | null>>({});

  useEffect(() => {
    let cancelled = false;
    void Promise.all(channels.map(async (c) => {
      const r = await fetchChannelMetrics(project, c.name);
      if (!cancelled) setReadouts((prev) => ({ ...prev, [c.name]: r }));
    }));
    return () => { cancelled = true; };
    // Re-fetch when the channel set or project changes; the channel objects are re-derived each
    // render so key on their names rather than identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, channels.map((c) => c.name).join(",")]);

  return (
    <Stack gap={14}>
      <SectionHeader title="Analytics" hint="the marketer's read-back (#3149) — reads whatever each channel reports" />
      <Row gap={10} wrap>
        <Card pad="sm" title="published"><Text size="lg" mono>{summary.published}</Text></Card>
        <Card pad="sm" title="opens"><Text size="lg" mono>{fmtMetric(summary.opens)}</Text></Card>
        <Card pad="sm" title="clicks"><Text size="lg" mono>{fmtMetric(summary.clicks)}</Text></Card>
        <Card pad="sm" title="impressions"><Text size="lg" mono>{fmtMetric(summary.impressions)}</Text></Card>
      </Row>
      <SectionHeader title="Per channel" />
      {channels.length === 0 ? (
        <Box className="hint">no channels connected yet</Box>
      ) : (
        <Stack gap={6}>
          {channels.map((c) => (
            <CardListRow key={c.id} lead={<StatusDot color="var(--fg-dim)" />} title={c.name} subtitle={fmtChannelReadout(readouts[c.name] ?? null)} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
