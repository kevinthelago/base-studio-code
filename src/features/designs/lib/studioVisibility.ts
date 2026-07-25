// studioVisibility (#3616) — is the Design Studio the page the user is actually LOOKING AT?
//
// DesignsWorkbench lives inside KeptMountedPage, which keeps it MOUNTED (CSS display:none) after the
// first visit so its state + PTY survive a page switch. That means its effects keep running while it's
// hidden — including `useComponentScan`, which esbuild-builds and hidden-iframe-probes all ~154
// components. Left ungated (`useComponentScan(true, …)`) that scan runs FOREVER in the background, pinning
// a WebView renderer near 40% CPU for a page nobody is looking at. Gating the scan on real visibility
// (the same condition the two KeptMountedPage wrappers use — App's `activeWorkspace === "projects"` AND
// the planner's `mode === "designs"`) pauses it when hidden and resumes it (sig-cache intact) on return.

/** True only when the Design Studio is the currently-shown page. `pageMode` is optional because
 *  `projectsPageMode` can be undefined before the projects workspace has picked a page. */
export function designStudioVisible(activeWorkspace: string, projectsPageMode: string | undefined): boolean {
  return activeWorkspace === "projects" && projectsPageMode === "designs";
}
