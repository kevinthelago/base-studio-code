// usePlanningTitle (#1775, extracted from Planning.tsx) — the editable project title for both
// lifecycles, KEEPING the frozen session key (the new name is a display name; a folder re-key is the
// stable-id refactor, out of scope):
//   • PUBLISHED rename (#1226) — commit updates the GitHub Project board title + local name.
//   • UNPUBLISHED draft (#1222) — commit persists to the draft record keyed by the frozen key.
import { useState, useCallback } from "react";
import { useAppStore } from "@/store";
import { githubGraphql } from "@/shared/lib/github/github";
import { planRename, applyRename } from "./renameProject";
import { planDraftCommit } from "./draftTitle";

type Store = ReturnType<typeof useAppStore.getState>;

export function usePlanningTitle(opts: {
  activeProjectId: Store["activeProjectId"];
  activeProjectName: Store["activeProjectName"];
  activeProjectNumber: Store["activeProjectNumber"];
  activeProjectRepos: Store["activeProjectRepos"];
  projectKeyAlias: Store["projectKeyAlias"];
  planningTitle: Store["planningTitle"];
  setPlanningTitle: Store["setPlanningTitle"];
  effectiveProjectId: string;
}) {
  const {
    activeProjectId, activeProjectName, activeProjectNumber, activeProjectRepos,
    projectKeyAlias, planningTitle, setPlanningTitle, effectiveProjectId,
  } = opts;

  // ── Rename a PUBLISHED project (#1226) ──────────────────────────────────────────
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [renameErr, setRenameErr] = useState<string | null>(null);
  const commitRename = useCallback(async () => {
    // The duplicate guard compares against OTHER projects' frozen keys (the alias values).
    const otherKeys = new Set(
      Object.entries(projectKeyAlias).filter(([nodeId]) => nodeId !== activeProjectId).map(([, k]) => k),
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
  }, [titleEdit, activeProjectName, activeProjectId, activeProjectNumber, activeProjectRepos, projectKeyAlias]);

  // ── Persist a DRAFT title edit (#1222) ──────────────────────────────────────────
  const [draftTitleErr, setDraftTitleErr] = useState<string | null>(null);
  const commitDraftTitle = useCallback(() => {
    const st = useAppStore.getState();
    const draft = st.localDraftProjects[effectiveProjectId];
    if (!draft) { setDraftTitleErr(null); return; } // not an unpublished draft — nothing to persist
    const otherKeys = new Set<string>();
    for (const k of Object.keys(st.localDraftProjects)) if (k !== effectiveProjectId) otherKeys.add(k);
    for (const [nodeId, k] of Object.entries(projectKeyAlias)) if (nodeId !== activeProjectId) otherKeys.add(k);
    const plan = planDraftCommit(planningTitle, draft.title, otherKeys);
    if (plan.kind === "revert") { setPlanningTitle(draft.title); setDraftTitleErr(null); return; }
    if (plan.kind === "noop") { setDraftTitleErr(null); return; }
    if (plan.kind === "error") { setDraftTitleErr(plan.message); return; } // keep the typed value to fix
    st.updateDraftProject(effectiveProjectId, { title: plan.title });
    setDraftTitleErr(null);
  }, [planningTitle, effectiveProjectId, activeProjectId, projectKeyAlias]);

  return { titleEdit, setTitleEdit, renameErr, setRenameErr, commitRename, draftTitleErr, setDraftTitleErr, commitDraftTitle };
}
