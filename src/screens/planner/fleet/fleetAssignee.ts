// Resolve the GitHub assignee for a published issue (#847). A worker/stream is an agent
// session, not a GitHub user, so the assignee is a human/collaborator login configured per
// stream (`AgentStream.assignee`), falling back to the account running the publish. The
// `stream:<id>` label stays as the agent-ownership marker; this drives the first-class
// GitHub assignee field. Pure + unit-tested; the publish flow applies it best-effort.

import type { AgentStream } from "../stages/planSections";

/**
 * The GitHub login to assign an issue to, given its owning stream id.
 *
 * - The owning stream's configured `assignee`, when set and non-empty.
 * - Otherwise the publishing account (`viewerLogin`) — so issues are never left unassigned.
 * - `null` only when there's no stream login AND no viewer login (assignment is then skipped).
 *
 * Trims whitespace; an all-whitespace stream assignee is treated as unset.
 */
export function resolveIssueAssignee(
  streamId: string | undefined,
  streams: readonly AgentStream[],
  viewerLogin: string,
): string | null {
  const stream = streamId ? streams.find((s) => s.id === streamId) : undefined;
  const streamLogin = stream?.assignee?.trim();
  if (streamLogin) return streamLogin;
  const viewer = viewerLogin.trim();
  return viewer || null;
}
