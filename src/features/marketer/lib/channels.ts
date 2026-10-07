// Channel status view (#3146/#3800 prep, epic #3145) — derives a marketer-facing channel list from
// the mcp feature's server catalog. The epic's architecture is that "a marketing channel IS an MCP
// server" (its tools are the channel actions, its `env` holds credentials); this module only READS
// that catalog through the mcp feature's public barrel (`@/features/mcp`) — it never mutates MCP
// server config, which stays the mcp feature's own concern.

import type { McpServer } from "@/features/mcp";
import type { ChannelKind } from "./campaign";

export interface ChannelView {
  id: string;
  name: string;
  kind: ChannelKind;
  /** Enabled/runnable — has a command (stdio) or url (http) it could actually dispatch through. */
  installed: boolean;
  /** Assigned to the marketer stream by name (mirrors `resolveStreamMcp`'s case-insensitive match). */
  assigned: boolean;
}

const EMAIL_HINT = /email|mail|resend|sendgrid|postmark/i;
const SOCIAL_HINT = /social|bluesky|mastodon|twitter|\bx\b|linkedin|threads/i;
const CHANNEL_HINT = /channel/i;

/** Heuristic channel kind from a server's display name (e.g. "Resend" → email, "Bluesky" → social). */
export function channelKindOf(name: string): ChannelKind {
  if (EMAIL_HINT.test(name)) return "email";
  if (SOCIAL_HINT.test(name)) return "social";
  return "other";
}

/** Whether an MCP server looks like a marketing channel — named "channel" (the built-in mock,
 *  #3146) or matching a known email/social provider hint. */
function looksLikeChannel(s: McpServer): boolean {
  return CHANNEL_HINT.test(s.name) || EMAIL_HINT.test(s.name) || SOCIAL_HINT.test(s.name);
}

/** Every channel-shaped MCP server, annotated with whether it's runnable and whether the marketer
 *  stream has it assigned. `servers` should be the full installed catalog (including disabled
 *  built-ins, e.g. `resolveAllInstalledMcp`) so a not-yet-assigned channel still shows up to connect. */
export function deriveChannelViews(servers: McpServer[], streamAssigned: string[] = []): ChannelView[] {
  const assigned = new Set(streamAssigned.map((n) => n.toLowerCase()));
  return servers
    .filter(looksLikeChannel)
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: channelKindOf(s.name),
      installed: s.transport === "http" ? !!s.url : !!s.command,
      assigned: assigned.has(s.name.toLowerCase()),
    }));
}
