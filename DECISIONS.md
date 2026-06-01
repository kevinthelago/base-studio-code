- B-wan-viewonly: gated BOTH PaneInput and PaneResize behind input_granted (view-only by default). Resize mutates the host PTY (SIGWINCH) so a view-only phone shouldn't impose dims; smallest reversible choice consistent with 'view-only'. Focus/set-state stay allowed (read-side filtering only).

- Touched src-tauri/src/lib.rs ONLY to register tunnel::tunnel_set_input_granted in the invoke_handler list (line ~3542). Did NOT touch the GitHub-proxy/credential region (release-eng's seam). Additive, single line.

