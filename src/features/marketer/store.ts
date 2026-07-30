// Marketer feature store (#3148, epic #3145 P3) — campaigns + content items, the
// draft→approve→schedule→publish loop.
//
// NOT folded into the app's composed `useAppStore` (#1309's `AppStore extends …Slice` pattern, see
// e.g. `features/automations/store.ts`): that would require a two-line edit to `src/store/index.ts` +
// `src/store/types.ts`, both outside this feature's write scope (`src/features/marketer/**`). This is
// a deliberate, working interim: a standalone store using the SAME persistence adapter the composed
// store uses (`persistStorage` — Tauri plugin-store's `app-state.json` in the app, localStorage in
// browser-only dev), under its own top-level key (`"bsc-marketer"`) so it never collides with the
// main store's key. Folding this into `AppStore` is a natural follow-up once a stream that owns
// `store/index.ts` does the two-line wiring — nothing here needs to change to support that.
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { persistStorage } from "@/shared/lib/core/storage";
import {
  newCampaign, newContentItem, advanceStatus,
  type Campaign, type ContentItem, type ContentStatus, type NewContentInput, type ContentMetrics, type ResearchRef,
} from "./lib/campaign";
import { complianceViolations, type ComplianceViolation } from "./lib/compliance";
import { dispatchContent } from "./lib/api";

let seq = 0;
/** A locally-unique id (no clock dependency for ordering within a session). */
function mintId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

export interface MarketerState {
  campaigns: Campaign[];
  contentItems: ContentItem[];

  addCampaign: (name: string, researchRef?: ResearchRef) => string;
  removeCampaign: (id: string) => void;

  addContentItem: (input: NewContentInput) => string;
  updateContentItem: (id: string, patch: Partial<ContentItem>) => void;
  removeContentItem: (id: string) => void;

  /** Approve a draft — blocked (returns the violations, no state change) while any compliance
   *  guardrail fails (#3150: "a content item failing a compliance check cannot reach approved"). */
  approveContentItem: (id: string) => { ok: boolean; violations: ComplianceViolation[] };
  /** Move an approved item to scheduled for a future ISO-8601 time. */
  scheduleContentItem: (id: string, scheduleAt: string) => { ok: boolean; reason?: string };
  /** Dispatch an approved/scheduled item through its channel (#3146/#3147) and mark it published.
   *  Tries the real backend command; when it isn't wired yet, mints a locally-simulated receipt
   *  (matching the channel tool's `<tool>-<n>` shape) so the loop still demos end to end. */
  publishContentItem: (id: string, project: string) => Promise<{ ok: boolean; reason?: string }>;
  recordMetrics: (id: string, metrics: ContentMetrics) => void;
}

/** The MCP tool a channel kind dispatches through — mirrors crates/channel's tool catalog. */
function toolFor(item: Pick<ContentItem, "channelKind">): "send_email" | "post" {
  return item.channelKind === "email" ? "send_email" : "post";
}

export const useMarketerStore = create<MarketerState>()(
  persist(
    (set, get) => ({
      campaigns: [],
      contentItems: [],

      addCampaign: (name, researchRef) => {
        const id = mintId("camp");
        const now = Date.now();
        set((s) => ({ campaigns: [...s.campaigns, newCampaign(name, id, now, researchRef)] }));
        return id;
      },

      removeCampaign: (id) =>
        set((s) => ({
          campaigns: s.campaigns.filter((c) => c.id !== id),
          contentItems: s.contentItems.filter((i) => i.campaignId !== id),
        })),

      addContentItem: (input) => {
        const id = mintId("item");
        const now = Date.now();
        const item = newContentItem(input, id, now);
        set((s) => ({
          contentItems: [...s.contentItems, item],
          campaigns: s.campaigns.map((c) => (c.id === input.campaignId ? { ...c, contentItemIds: [...c.contentItemIds, id], updatedAt: now } : c)),
        }));
        return id;
      },

      updateContentItem: (id, patch) =>
        set((s) => ({
          contentItems: s.contentItems.map((i) => (i.id === id ? { ...i, ...patch, updatedAt: Date.now() } : i)),
        })),

      removeContentItem: (id) =>
        set((s) => {
          const item = s.contentItems.find((i) => i.id === id);
          return {
            contentItems: s.contentItems.filter((i) => i.id !== id),
            campaigns: item
              ? s.campaigns.map((c) => (c.id === item.campaignId ? { ...c, contentItemIds: c.contentItemIds.filter((cid) => cid !== id) } : c))
              : s.campaigns,
          };
        }),

      approveContentItem: (id) => {
        const item = get().contentItems.find((i) => i.id === id);
        if (!item) return { ok: false, violations: [] };
        const violations = complianceViolations(item);
        if (violations.length > 0) return { ok: false, violations };
        const res = advanceStatus(item, "approved", Date.now());
        if (!res.ok) return { ok: false, violations: [] };
        set((s) => ({ contentItems: s.contentItems.map((i) => (i.id === id ? res.item : i)) }));
        return { ok: true, violations: [] };
      },

      scheduleContentItem: (id, scheduleAt) => {
        const item = get().contentItems.find((i) => i.id === id);
        if (!item) return { ok: false, reason: "not found" };
        const res = advanceStatus(item, "scheduled", Date.now(), { scheduleAt });
        if (!res.ok) return { ok: false, reason: res.reason };
        set((s) => ({ contentItems: s.contentItems.map((i) => (i.id === id ? res.item : i)) }));
        return { ok: true };
      },

      publishContentItem: async (id, project) => {
        const item = get().contentItems.find((i) => i.id === id);
        if (!item) return { ok: false, reason: "not found" };
        if (!canTransitionToPublished(item.status)) return { ok: false, reason: `cannot publish from ${item.status}` };

        const receipt = await dispatchContent(project, item);
        const receiptId = receipt?.id ?? `${toolFor(item)}-sim-${mintId("r")}`;
        const res = advanceStatus(item, "published", Date.now(), { receiptId });
        if (!res.ok) return { ok: false, reason: res.reason };
        set((s) => ({ contentItems: s.contentItems.map((i) => (i.id === id ? res.item : i)) }));
        return { ok: true };
      },

      recordMetrics: (id, metrics) =>
        set((s) => ({
          contentItems: s.contentItems.map((i) => (i.id === id ? { ...i, metrics: { ...i.metrics, ...metrics }, updatedAt: Date.now() } : i)),
        })),
    }),
    { name: "bsc-marketer", storage: createJSONStorage(() => persistStorage) },
  ),
);

function canTransitionToPublished(status: ContentStatus): boolean {
  return status === "approved" || status === "scheduled";
}
