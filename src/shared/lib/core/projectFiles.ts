// Shared project-hub file capability — the persistence primitive a pipeline calls from
// inside its own save/confirm behavior (#…). Pipelines decide what/where/when to write;
// this is just the path-safe transport to `~/.base-studio-code/projects/<key>/`. Thin
// wrappers over the Rust `write_project_file` / `read_project_files` commands.

import { invoke } from "@tauri-apps/api/core";

/** Write one file under the project hub. `relpath` is resolved under the project dir;
 *  the Rust side rejects any path that would escape it. */
export function writeProjectFile(projectKey: string, relpath: string, contents: string): Promise<void> {
  return invoke("write_project_file", { projectKey, relpath, contents });
}

/** Read every file under a project-hub subdir as `[relpath, contents]` pairs (empty when
 *  the subdir is missing). Used by a pipeline to rehydrate its saved results. */
export function readProjectFiles(projectKey: string, subdir: string): Promise<[string, string][]> {
  return invoke("read_project_files", { projectKey, subdir });
}
