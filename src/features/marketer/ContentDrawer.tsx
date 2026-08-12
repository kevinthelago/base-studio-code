import { useState } from "react";
import { Pane } from "@/shared/ui/overlay/Pane";
import { Chip } from "@/shared/ui/data/Chip";
import { InlineError } from "@/shared/ui/feedback/InlineError";
import { Button } from "@/shared/ui/controls/Button";
import { TextField, TextArea, Field } from "@/shared/ui/controls/Field";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { complianceViolations } from "./lib/compliance";
import type { ContentItem, ContentStatus, ChannelKind } from "./lib/campaign";

const STATUS_TONE: Record<ContentStatus, "neutral" | "accent" | "success" | "info"> = {
  draft: "neutral",
  approved: "info",
  scheduled: "accent",
  published: "success",
};

export interface ContentDrawerProps {
  item: ContentItem | null;
  onClose: () => void;
  onPatch: (patch: Partial<ContentItem>) => void;
  onApprove: () => { ok: boolean };
  onSchedule: (whenIso: string) => void;
  onPublish: () => void;
  publishing?: boolean;
}

/** The compose/approve/schedule/publish editor for one content item (#3148's loop). Shows the
 *  compliance guardrail violations (#3150) blocking approval, and the action available for the
 *  item's current status — never lets the user reach for an action the state machine forbids. */
export function ContentDrawer({ item, onClose, onPatch, onApprove, onSchedule, onPublish, publishing }: ContentDrawerProps) {
  const [scheduleAt, setScheduleAt] = useState("");
  const violations = item ? complianceViolations(item) : [];
  const editable = item?.status === "draft";

  return (
    <Pane
      open={!!item}
      onClose={onClose}
      header={item && (
        <>
          <Chip tone={STATUS_TONE[item.status]}>{item.status}</Chip>
          <Text as="div" style={{ fontWeight: 600, fontSize: 13 }}>{item.channel}</Text>
        </>
      )}
      body={item && (
        <Stack gap={12}>
          {editable && (
            <Field label="content kind">
              <SegmentedControl
                options={(["email", "social"] as ChannelKind[]).map((k) => ({
                  label: k, on: item.channelKind === k, onClick: () => onPatch({ channelKind: k }),
                }))}
              />
            </Field>
          )}
          {item.channelKind === "email" && (
            <TextField label="subject" placeholder="subject line" value={item.subject ?? ""} onChange={(v) => onPatch({ subject: v })} disabled={!editable} />
          )}
          <TextArea label="body" placeholder="draft the content…" value={item.body} onChange={(v) => onPatch({ body: v })} disabled={!editable} rows={8} />
          {item.channelKind === "email" && (
            <TextField
              label="sender identity"
              hint="company name + physical address — required for CAN-SPAM/GDPR"
              placeholder="Acme Inc, 1 Main St"
              value={item.senderIdentity ?? ""}
              onChange={(v) => onPatch({ senderIdentity: v })}
              disabled={!editable}
            />
          )}

          {violations.length > 0 && (
            <Stack gap={6}>
              {violations.map((v) => (
                <InlineError key={v.code}>{v.message}</InlineError>
              ))}
            </Stack>
          )}

          {item.status === "scheduled" && (
            <Box className="hint">scheduled for {new Date(item.scheduleAt ?? "").toLocaleString()}</Box>
          )}
          {item.status === "published" && (
            <Row gap={8} wrap>
              <Chip tone="success">published {item.publishedAt ? new Date(item.publishedAt).toLocaleString() : ""}</Chip>
              {item.receiptId && <Chip>receipt: {item.receiptId}</Chip>}
            </Row>
          )}
        </Stack>
      )}
      footer={item && (
        <Row gap={8} justify="between" style={{ width: "100%" }}>
          <Button variant="ghost" onClick={onClose}>close</Button>
          <Row gap={8}>
            {item.status === "draft" && (
              <Button variant="primary" disabled={violations.length > 0} onClick={onApprove}>approve</Button>
            )}
            {item.status === "approved" && (
              <>
                {/* eslint-disable-next-line no-restricted-syntax -- inline datetime-local input paired with a Schedule button in the footer row; a TextField .field wrapper would break the row layout */}
                <input
                  type="datetime-local"
                  className="input"
                  value={scheduleAt}
                  onChange={(e) => setScheduleAt(e.target.value)}
                  style={{ height: 28 }}
                />
                <Button
                  onClick={() => scheduleAt && onSchedule(new Date(scheduleAt).toISOString())}
                  disabled={!scheduleAt}
                >schedule</Button>
                <Button variant="primary" onClick={onPublish} disabled={publishing}>
                  {publishing ? "publishing…" : "publish now"}
                </Button>
              </>
            )}
            {item.status === "scheduled" && (
              <Button variant="primary" onClick={onPublish} disabled={publishing}>
                {publishing ? "publishing…" : "publish now"}
              </Button>
            )}
          </Row>
        </Row>
      )}
    />
  );
}
