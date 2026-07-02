import { useState, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { Trash2 } from "lucide-react";
import { useAppStore } from "@/store";
import { overlayDismiss } from "@/shared/hooks/useModalDismiss";
import { Button } from "@/shared/ui/controls/Button";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { InlineError } from "@/shared/ui/feedback/InlineError";
import { DELETE_MUTATION, type GhProject } from "./publishedModel";

interface DeleteProjectModalProps {
  target: GhProject;
  onClose: () => void;
  setProjects: Dispatch<SetStateAction<GhProject[]>>;
}

/** Published-project delete — Keep vs Delete (#1216). A published project is a real shipped app
 *  on GitHub (board + milestones + issues + repos), so removing it from base-studio-code must
 *  NOT silently tear down that structure. Keep (default/safe) = local cleanup only; Delete
 *  everything (deliberate, secondary) layers the GitHub project DELETE_MUTATION on top, behind
 *  an explicit second confirm. */
export function DeleteProjectModal({ target, onClose, setProjects }: DeleteProjectModalProps) {
  const { githubToken, deleteLocalProject, dismissProject } = useAppStore();
  const [deleting, setDeleting]   = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Published-delete is a two-step Keep-vs-Delete flow (#1216): the modal first offers Keep (default,
  // safe) vs "delete everything"; choosing the destructive path arms a deliberate second confirm
  // before it runs the GitHub project DELETE_MUTATION.
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  // The third, most-destructive path: also permanently DELETE the GitHub repositories + their code.
  const [confirmDeleteRepos, setConfirmDeleteRepos] = useState(false);

  function closeDeleteModal() {
    setDeleteError(null);
    setConfirmDeleteAll(false);
    setConfirmDeleteRepos(false);
    onClose();
  }

  // Remove ONLY the local footprint of a published project (#1216 "Keep the app"): the on-disk hub +
  // per-project store state + a persisted dismissal so the next GitHub sync doesn't re-list it. The
  // GitHub board / milestones / issues / repos are left completely untouched (no DELETE_MUTATION).
  // Shared by Keep and by "delete everything" (which layers the GitHub teardown on top).
  async function removeLocalFootprint(p: GhProject) {
    // delete_project_dir clears Windows read-only files first (#793) and handles relocated worktrees
    // without following a node_modules junction into the shared main node_modules.
    await safeInvoke("delete_project_dir", { projectKey: p.title }, undefined,
      (e) => console.warn(`delete_project_dir failed: ${e}`));
    // Pass BOTH the title and the GitHub node id: deleteLocalProject resolves the node id through the
    // alias to the slug-keyed maps (#997) and guards undefined slices (#874/#791), and clears the
    // active/planning session if this was the open project.
    deleteLocalProject([p.title, p.id]);
    // Persist the removal so the next GitHub sync (which still returns closed / not-yet-purged
    // boards) doesn't re-add the card (#85).
    dismissProject(p.id);
    setProjects(prev => prev.filter(x => x.id !== p.id));
  }

  // "Keep the app — stop tracking it here" (#1216, the default / safe path): local cleanup only.
  async function handleDeleteKeep() {
    setDeleting(true);
    setDeleteError(null);
    await removeLocalFootprint(target);
    setDeleting(false);
    closeDeleteModal();
  }

  // "Delete everything" (#1216, the explicitly destructive path): the local cleanup PLUS the GitHub
  // Project DELETE_MUTATION (tears down the project BOARD — not the repos / their code).
  async function handleDeleteEverything() {
    setDeleting(true);
    setDeleteError(null);
    // Best-effort GitHub delete: a project already deleted on the web returns a GraphQL "could not
    // resolve to a node" error, which must NOT block removing it locally — that was the bug where
    // stale projects couldn't be cleared (#85).
    if (githubToken) {
      try {
        await invoke("github_graphql", {
          token: githubToken,
          query: DELETE_MUTATION,
          variables: { projectId: target.id },
        });
      } catch (e) {
        console.warn(`github project delete failed (removing locally anyway): ${e}`);
      }
    }
    await removeLocalFootprint(target);
    setDeleting(false);
    closeDeleteModal();
  }

  // "Delete everything + repositories" — the MOST destructive path: handleDeleteEverything PLUS a
  // best-effort REST delete of every linked GitHub repository (needs the token's `delete_repo` scope).
  // Repos go first; failures are collected and surfaced (the local copy + board still get removed).
  async function handleDeleteWithRepos() {
    setDeleting(true);
    setDeleteError(null);
    const repos = target.repositories?.nodes?.map((r) => r.nameWithOwner) ?? [];
    const failed: string[] = [];
    if (githubToken) {
      for (const fullName of repos) {
        try {
          await invoke("github_delete", { token: githubToken, path: `repos/${fullName}` });
        } catch (e) {
          console.warn(`repo delete failed for ${fullName}: ${e}`);
          failed.push(fullName);
        }
      }
      // Then tear down the project board (best-effort, like handleDeleteEverything).
      try {
        await invoke("github_graphql", {
          token: githubToken,
          query: DELETE_MUTATION,
          variables: { projectId: target.id },
        });
      } catch (e) {
        console.warn(`github project delete failed (removing locally anyway): ${e}`);
      }
    }
    await removeLocalFootprint(target);
    setDeleting(false);
    if (failed.length > 0) {
      // Local copy + board are gone, but some repos couldn't be deleted — surface which (a missing
      // `delete_repo` scope is the usual cause) and keep the modal open so the message is seen.
      setDeleteError(
        `Couldn't delete ${failed.length} repositor${failed.length === 1 ? "y" : "ies"}: ${failed.join(", ")}. ` +
          "Your token may lack the `delete_repo` scope — delete them on GitHub. The local copy and project board were removed.",
      );
    } else {
      closeDeleteModal();
    }
  }

  return (
    <Box className="modal-scrim" onClick={overlayDismiss(deleting ? undefined : closeDeleteModal)}>
      <Box pad={[24, 28]} bg="var(--bg-elev)" border="soft" radius="lg" style={{ width: 460, maxWidth: "90vw",
      }}>
        {confirmDeleteRepos ? (
          (() => {
            const repoNames = target.repositories?.nodes?.map((r) => r.nameWithOwner) ?? [];
            return (
              <>
                <Text as="h3" mono size={14} tone="danger" style={{ margin: "0 0 8px" }}>
                  Delete everything + repositories?
                </Text>
                <Text as="p" size={12} tone="muted" style={{ margin: "0 0 18px", lineHeight: 1.6 }}>
                  This <b style={{ color: "var(--fg)" }}>permanently deletes</b> the local copy, the GitHub project
                  board, and{" "}
                  <b style={{ color: "var(--fg)" }}>
                    {repoNames.length > 0 ? `${repoNames.length} GitHub repositor${repoNames.length === 1 ? "y" : "ies"}` : "the linked repositories"} and all their code
                  </b>{" "}
                  for <b style={{ color: "var(--fg)" }}>{target.title}</b>.{" "}
                  <b style={{ color: "var(--danger)" }}>This cannot be undone.</b>
                </Text>
                {repoNames.length > 0 && (
                  <Text as="div" mono size={11} tone="muted" style={{ marginBottom: 16, lineHeight: 1.7 }}>
                    {repoNames.map((r) => <Box key={r}>· {r}</Box>)}
                  </Text>
                )}
                {deleteError && (
                  <InlineError style={{ marginBottom: 14 }}>
                    {deleteError}
                  </InlineError>
                )}
                <Row gap={8} align="stretch" justify="end">
                  <Button variant="ghost" onClick={() => { setConfirmDeleteRepos(false); setDeleteError(null); }} disabled={deleting}>back</Button>
                  <Button danger onClick={handleDeleteWithRepos} disabled={deleting} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Trash2 size={12} />
                    {deleting ? "deleting…" : "delete everything + repos"}
                  </Button>
                </Row>
              </>
            );
          })()
        ) : !confirmDeleteAll ? (
          <>
            <Text as="h3" mono size={14} style={{ margin: "0 0 8px", color: "var(--fg)" }}>
              Remove “{target.title}”?
            </Text>
            <Text as="p" size={12} tone="muted" style={{ margin: "0 0 18px", lineHeight: 1.6 }}>
              This project is published to GitHub. Choose whether to keep the shipped app on GitHub
              or delete everything.
            </Text>
            {deleteError && (
              <InlineError style={{ marginBottom: 14 }}>
                {deleteError}
              </InlineError>
            )}
            {/* Keep — the default / safe primary action. */}
            <Button
              variant="primary"
              onClick={handleDeleteKeep}
              disabled={deleting}
              autoFocus
              style={{ width: "100%", textAlign: "left", padding: "11px 14px", height: "auto", display: "block", marginBottom: 10 }}
            >
              <Box as="span" style={{ display: "block", fontSize: 12.5, fontWeight: 600 }}>Keep the app — stop tracking it here</Box>
              <Box as="span" className="mono" style={{ display: "block", fontSize: 10.5, opacity: 0.85, marginTop: 3, lineHeight: 1.5 }}>
                Removes the local copy only. Your GitHub project board, milestones, issues, and repos stay intact.
              </Box>
            </Button>
            {/* Delete everything — secondary; arms the explicit destructive confirm (NOT the default). */}
            <Button
              variant="ghost"
              onClick={() => { setConfirmDeleteAll(true); setDeleteError(null); }}
              disabled={deleting}
              style={{ width: "100%", textAlign: "left", padding: "11px 14px", height: "auto", display: "block", color: "var(--danger)", marginBottom: 16 }}
            >
              <Box as="span" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600 }}>
                <Trash2 size={12} /> Delete everything
              </Box>
              <Box as="span" className="mono" style={{ display: "block", fontSize: 10.5, opacity: 0.85, marginTop: 3, lineHeight: 1.5 }}>
                Removes the local copy AND deletes the GitHub project board. (Your repos and their code are not deleted.)
              </Box>
            </Button>
            {/* Delete everything + repositories — the MOST destructive; arms its own confirm. */}
            <Button
              variant="ghost"
              onClick={() => { setConfirmDeleteRepos(true); setDeleteError(null); }}
              disabled={deleting}
              style={{ width: "100%", textAlign: "left", padding: "11px 14px", height: "auto", display: "block", color: "var(--danger)", marginBottom: 16 }}
            >
              <Box as="span" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600 }}>
                <Trash2 size={12} /> Delete everything + repositories
              </Box>
              <Box as="span" className="mono" style={{ display: "block", fontSize: 10.5, opacity: 0.85, marginTop: 3, lineHeight: 1.5 }}>
                Removes the local copy, the GitHub project board, AND permanently deletes the linked GitHub repositories and all their code. This cannot be undone.
              </Box>
            </Button>
            <Row gap={8} align="stretch" justify="end">
              <Button variant="ghost" onClick={closeDeleteModal} disabled={deleting}>cancel</Button>
            </Row>
          </>
        ) : (
          <>
            <Text as="h3" mono size={14} tone="danger" style={{ margin: "0 0 8px" }}>
              Delete everything?
            </Text>
            <Text as="p" size={12} tone="muted" style={{ margin: "0 0 18px", lineHeight: 1.6 }}>
              This permanently deletes the <b style={{ color: "var(--fg)" }}>GitHub project board</b> for{" "}
              <b style={{ color: "var(--fg)" }}>{target.title}</b> (its milestones and issue cards) and
              removes the local copy. <b style={{ color: "var(--fg)" }}>Your repositories and their code are not deleted</b> —
              only the project board is.
            </Text>
            {deleteError && (
              <InlineError style={{ marginBottom: 14 }}>
                {deleteError}
              </InlineError>
            )}
            <Row gap={8} align="stretch" justify="end">
              <Button
                variant="ghost"
                onClick={() => { setConfirmDeleteAll(false); setDeleteError(null); }}
                disabled={deleting}
              >back</Button>
              <Button
                danger
                onClick={handleDeleteEverything}
                disabled={deleting}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                <Trash2 size={12} />
                {deleting ? "deleting…" : "delete everything"}
              </Button>
            </Row>
          </>
        )}
      </Box>
    </Box>
  );
}
