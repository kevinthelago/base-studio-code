- B-wan-viewonly: gated BOTH PaneInput and PaneResize behind input_granted (view-only by default). Resize mutates the host PTY (SIGWINCH) so a view-only phone shouldn't impose dims; smallest reversible choice consistent with 'view-only'. Focus/set-state stay allowed (read-side filtering only).

- Touched src-tauri/src/lib.rs ONLY to register tunnel::tunnel_set_input_granted in the invoke_handler list (line ~3542). Did NOT touch the GitHub-proxy/credential region (release-eng's seam). Additive, single line.

- Verified this session (no edits): B-wan-viewonly (#357) and B-unpair-revoke (#358) already fully landed on the tunnel-security branch — tunnel.rs (tunnel_unpair + rotation + psk_is_fresh_rotatable_hex test), lib.rs:3543 command registration, tunnelClient.ts:28, Tunnel.tsx unpair UI. 11/11 cargo tunnel tests green. Both close the WAN-safety half of epic #208.

- skills stream: backend-core owns src-tauri/src/lib.rs (write_session_skills, ensure_session_settings skills arg, bsc-skill hook, read_skill_log) and TerminalView.tsx owns the paneSkills->session injection wiring -- both OUTSIDE my lane. Building the full frontend contract (lib/skills.ts SkillCfg payload + lib/skillTelemetry.ts + store paneSkills) and will coordinate the Rust/TerminalView wiring with the director via bsc-ask.

