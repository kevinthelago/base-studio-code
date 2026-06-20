// Shared composite-key helper for per-repo, project-scoped assignments.
//
// The startup-prompt *resolution* that used to live here has moved to
// lib/assignments.ts (#324/#326), which unifies it with reference-context
// resolution under one document-assignment model. Only this key helper remains,
// because it is used pervasively across the store to key per-repo maps; its
// format is byte-identical to the assignments module's `scopeKey`, so the two
// interoperate directly.

/** Composite key for a per-repo override scoped to a project. */
export function repoPromptKey(projectId: string, repo: string): string {
  return `${projectId}::${repo}`;
}
