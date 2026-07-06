// usePlanningTitle (#1775, extracted from Planning.tsx) — the editable project title for both
// lifecycles, KEEPING the frozen session key (#2409: renames are display-only — the folder keeps
// its birth-slug; a later reopen under the new name resolves via the reopen-mismatch modal):
//   • PUBLISHED rename (#1226) — commit updates the GitHub Project board title + local name.
//   • UNPUBLISHED draft (#1222) — commit persists to the draft record keyed by the frozen key.
import { useState, useCallback } from "react";
import { useAppStore } from "@/store";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { githubGraphql } from "@/shared/lib/github/github";
import { planRename, applyRename } from "./renameProject";
import { planDraftCommit } from "./draftTitle";

type Store = ReturnType<typeof useAppStore.getState>;

export function usePlanningTitle(opts: {
  activeProjectId: Store["activeProjectId"];
  activeProjectName: Store["activeProjectName"];
  activeProjectNumber: Store["activeProjectNumber"];
  activeProjectRepos: Store["activeProjectRepos"];
  planningTitle: Store["planningTitle"];
  setPlanningTitle: Store["setPlanningTitle"];
  effectiveProjectId: string;
}) {
  const {
    activeProjectId, activeProjectName, activeProjectNumber, activeProjectRepos,
    planningTitle, setPlanningTitle, effectiveProjectId,
  } = opts;

  // ── Rename a PUBLISHED project (#1226) ──────────────────────────────────────────
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [renameErr, setRenameErr] = useState<string | null>(null);
  const commitRename = useCallback(async () => {
    // The duplicate guard compares against OTHER projects' frozen keys — the draft-map keys
    // (name-derived slugs, #2409). Renames are display-only (the folder keeps its birth-slug), so
    // a rename that slugs onto another key would only surface later as a reopen collision — this
    // guard catches it up front where the store knows the other keys.
    const st0 = useAppStore.getState();
    const otherKeys = new Set(
      Object.keys(st0.localDraftProjects).filter((k) => k !== effectiveProjectId),
    );
    const plan = planRename(titleEdit ?? "", activeProjectName, activeProjectId, otherKeys);
    setTitleEdit(null);
    if (plan.kind === "noop") { setRenameErr(null); return; }
    if (plan.kind === "error") { setRenameErr(plan.message); return; }
    const st = useAppStore.getState();
    setRenameErr(
      await applyRename(activeProjectId!, plan.title, {
        graphql: githubGraphql,
        setMeta: st.setActiveProjectMeta,
        repo: st.activeProjectRepo,
        number: activeProjectNumber,
        repos: activeProjectRepos,
      }),
    );
    // Keep the on-disk hub title (`projects/<key>/.title`) in step with the rename so the durable
    // name — read by list_local_projects and the session skill-group naming — reflects the new title.
    fireInvoke("set_project_title", { projectKey: effectiveProjectId, title: plan.title });
  }, [titleEdit, activeProjectName, activeProjectId, activeProjectNumber, activeProjectRepos, effectiveProjectId]);

  // ── Persist a DRAFT title edit (#1222) ──────────────────────────────────────────
  const [draftTitleErr, setDraftTitleErr] = useState<string | null>(null);
  const commitDraftTitle = useCallback(() => {
    const st = useAppStore.getState();
    const draft = st.localDraftProjects[effectiveProjectId];
    if (!draft) { setDraftTitleErr(null); return; } // not an unpublished draft — nothing to persist
    const otherKeys = new Set<string>();
    for (const k of Object.keys(st.localDraftProjects)) if (k !== effectiveProjectId) otherKeys.add(k);
    const plan = planDraftCommit(planningTitle, draft.title, otherKeys);
    if (plan.kind === "revert") { setPlanningTitle(draft.title); setDraftTitleErr(null); return; }
    if (plan.kind === "noop") { setDraftTitleErr(null); return; }
    if (plan.kind === "error") { setDraftTitleErr(plan.message); return; } // keep the typed value to fix
    st.updateDraftProject(effectiveProjectId, { title: plan.title });
    // Mirror the draft rename into the durable hub title (`.title`) so the on-disk name doesn't fall
    // back to a key-derived placeholder once goal.md/the store drift out of view.
    fireInvoke("set_project_title", { projectKey: effectiveProjectId, title: plan.title });
    setDraftTitleErr(null);
  }, [planningTitle, effectiveProjectId, setPlanningTitle]);

  return { titleEdit, setTitleEdit, renameErr, setRenameErr, commitRename, draftTitleErr, setDraftTitleErr, commitDraftTitle };
}
