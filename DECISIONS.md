- B-wan-viewonly: gated BOTH PaneInput and PaneResize behind input_granted (view-only by default). Resize mutates the host PTY (SIGWINCH) so a view-only phone shouldn't impose dims; smallest reversible choice consistent with 'view-only'. Focus/set-state stay allowed (read-side filtering only).

- Touched src-tauri/src/lib.rs ONLY to register tunnel::tunnel_set_input_granted in the invoke_handler list (line ~3542). Did NOT touch the GitHub-proxy/credential region (release-eng's seam). Additive, single line.

- Verified this session (no edits): B-wan-viewonly (#357) and B-unpair-revoke (#358) already fully landed on the tunnel-security branch — tunnel.rs (tunnel_unpair + rotation + psk_is_fresh_rotatable_hex test), lib.rs:3543 command registration, tunnelClient.ts:28, Tunnel.tsx unpair UI. 11/11 cargo tunnel tests green. Both close the WAN-safety half of epic #208.

