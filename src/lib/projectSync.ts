// GitHub-project resolution for publish/sync + the triage launch gate (#444).
//
// Publishing/syncing must land on ONE board: when a project isn't linked yet, creation
// used to fire blindly and mint a *second* board on every re-sync of a same-titled
// project. `ensureGithubProject` adopts an existing same-title board before creating.
// The GraphQL executor is injected so the adopt-vs-create decision is unit-testable
// without a live GitHub. Triage is gated until the project is actually published.

import { findByTitle } from "./projectPaths";

/** A GitHub Projects v2 board, as the owner lookup returns it. */
export interface GithubProjectRef {
  id: string;
  number: number;
  title: string;
  url: string;
}

/** The desktop's `github_graphql` bridge, injected so callers (and tests) supply it. */
export type Gql = (query: string, variables: unknown) => Promise<Record<string, unknown>>;

/**
 * First board whose title matches `title` (case/whitespace-insensitive), or null.
 * The dedupe guard that stops publish from creating a duplicate board; shares the one
 * title matcher (#380) so "a project with this title exists" is judged consistently.
 */
export function findProjectByTitle(
  boards: readonly GithubProjectRef[],
  title: string,
): GithubProjectRef | null {
  return findByTitle(boards, title, (b) => b.title);
}

/** How `ensureGithubProject` resolved the board to publish into. */
export type EnsureProjectResult =
  | { action: "linked"; id: string }                                  // already linked (activeProjectId)
  | { action: "adopted"; id: string; number: number; url: string }    // found an existing same-title board
  | { action: "created"; id: string; number: number; url: string };   // created a fresh board

const OWNER_PROJECTS_QUERY = `query($login:String!){
  repositoryOwner(login:$login){
    id
    ... on ProjectV2Owner { projectsV2(first:100){ nodes { id number title url } } }
  }
}`;

const CREATE_PROJECT_MUTATION = `mutation($ownerId:ID!,$title:String!){
  createProjectV2(input:{ownerId:$ownerId,title:$title}){ projectV2 { id number url } }
}`;

/**
 * Resolve the GitHub Project board a publish/sync should use — adopt-or-create, never a
 * blind duplicate (#444).
 *
 * Order: an already-linked board (`activeProjectId`) wins untouched; otherwise the
 * owner's existing boards are fetched and a title match is ADOPTED; only when none
 * exists is a new board created. The single round-trip resolves the owner id and its
 * boards together. Throws if the owner can't be resolved or creation returns nothing.
 */
export async function ensureGithubProject(
  gql: Gql,
  args: { activeProjectId: string | null; ownerLogin: string; title: string },
): Promise<EnsureProjectResult> {
  if (args.activeProjectId) return { action: "linked", id: args.activeProjectId };

  const data = (await gql(OWNER_PROJECTS_QUERY, { login: args.ownerLogin })) as {
    repositoryOwner?: { id?: string; projectsV2?: { nodes?: GithubProjectRef[] } };
  };
  const ownerId = data.repositoryOwner?.id;
  if (!ownerId) throw new Error(`could not resolve owner '${args.ownerLogin}'`);

  const existing = findProjectByTitle(data.repositoryOwner?.projectsV2?.nodes ?? [], args.title);
  if (existing) {
    return { action: "adopted", id: existing.id, number: existing.number, url: existing.url };
  }

  const created = (await gql(CREATE_PROJECT_MUTATION, { ownerId, title: args.title })) as {
    createProjectV2?: { projectV2?: { id: string; number: number; url: string } };
  };
  const pv = created.createProjectV2?.projectV2;
  if (!pv) throw new Error("project not created");
  return { action: "created", id: pv.id, number: pv.number, url: pv.url };
}

/** Inputs to the triage launch gate (#444). */
export interface TriageGateState {
  /** The project is published to GitHub — a board exists (activeProjectId set). */
  published: boolean;
  /** At least one repository is linked. */
  hasRepos: boolean;
  /** A fleet with at least one stream is planned. */
  hasFleet: boolean;
  /** A launch is already in flight. */
  busy: boolean;
}

/**
 * Whether "Triage →" may launch (#444): the project must be published (so issues exist
 * to triage), have repos + a planned fleet, and not already be starting. Locking triage
 * until publish stops a triage session spinning up against a project with no board/issues.
 */
export function canLaunchTriage(s: TriageGateState): boolean {
  return s.published && s.hasRepos && s.hasFleet && !s.busy;
}

/** Why triage is locked (tooltip), or null when it can launch (#444). */
export function triageLockReason(s: TriageGateState): string | null {
  if (s.busy) return "starting…";
  if (!s.published) return "Publish the project to GitHub first";
  if (!s.hasRepos) return "Link at least one repository first";
  if (!s.hasFleet) return "Plan the agent fleet first";
  return null;
}
