import { useMarketerStore } from "./store";
import { Box } from "@/shared/ui/layout/Box";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";

/** Live marketing-loop summary (mirrors AutomationsStatus) — how many drafts are waiting on
 *  approval and how many items are queued for send. A future Glance marketing band (#3800) can
 *  reuse this same read rather than re-deriving it. */
export function MarketerStatus() {
  const items = useMarketerStore((s) => s.contentItems);
  const drafts = items.filter((i) => i.status === "draft").length;
  const queued = items.filter((i) => i.status === "approved" || i.status === "scheduled").length;

  if (items.length === 0) {
    return (
      <Box as="span" className="s" style={{ color: "var(--fg-dim)" }}>
        <StatusDot color="var(--fg-dim)" size={7} /> no campaigns yet
      </Box>
    );
  }
  return (
    <Box as="span" className="s">
      <StatusDot color={drafts > 0 ? "var(--accent)" : "var(--fg-dim)"} size={7} />
      {drafts > 0 ? `${drafts} draft${drafts === 1 ? "" : "s"} awaiting approval` : "all drafts approved"}
      {queued > 0 && ` · ${queued} queued to send`}
    </Box>
  );
}
