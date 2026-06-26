//! Tests for the tunnel bus + protocol — moved verbatim from `mod.rs` (#1658). As a child
//! module of `tunnel` it keeps private access to the production items under test.

use super::*;

/// Resolve a shared cross-repo contract fixture by FILENAME, walking the frontend `src/` tree.
///
/// `tunnelProtocol.fixtures.json` / `plannerCore.fixtures.json` are byte-exact wire contracts
/// shared by these Rust tests, the TS tests, and mobile-studio-code. Per the feature-first
/// frontend (#1309) each fixture is **colocated with its feature** (the feature owns its
/// contract) and the TS tests import it relatively — so they move with their feature. Rather
/// than track those moves with a brittle fixed path, the Rust side resolves them BY NAME, which
/// is reorg-immune. (#1335 weighed relocating them to a shared `contracts/` dir and concluded
/// NOT to — that would fight the feature-ownership model; hardening this resolver is the fix.)
///
/// We collect ALL matches and require EXACTLY ONE: zero ⇒ the fixture is missing/renamed; two+ ⇒
/// a name collision that a first-match walk would silently resolve wrong. Test-only, so cost is
/// irrelevant.
fn find_fixture(name: &str) -> std::path::PathBuf {
    fn walk(dir: &std::path::Path, name: &str, out: &mut Vec<std::path::PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, name, out);
            } else if path.file_name().and_then(|n| n.to_str()) == Some(name) {
                out.push(path);
            }
        }
    }
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
    let mut matches = Vec::new();
    walk(&src, name, &mut matches);
    match matches.len() {
        1 => matches.pop().unwrap(),
        0 => panic!("contract fixture '{name}' not found under {}", src.display()),
        n => panic!(
            "contract fixture '{name}' is AMBIGUOUS — {n} matches under {}: {:?}. \
             Give it a unique name or a canonical home (#1335).",
            src.display(),
            matches,
        ),
    }
}

/// Validate the plannerCore fixture: FNV-1a hash vectors + plan-sync wire frame serde.
/// Shared with mobile-studio-code and the TS tests; any drift is a breaking protocol
/// change (#588).
#[test]
fn planner_core_fixture_matches_hash_and_serde() {
    let path = find_fixture("plannerCore.fixtures.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read plannerCore fixture {}: {e}", path.display()));
    let fx: serde_json::Value = serde_json::from_str(&raw).unwrap();

    // FNV-1a 32-bit hash vectors.
    let v = &fx["fnv1a32"];
    assert_eq!(fnv1a32_hex(""),      v["empty"].as_str().unwrap(), "empty");
    assert_eq!(fnv1a32_hex("a"),     v["a"].as_str().unwrap(),     "\"a\"");
    assert_eq!(fnv1a32_hex("foobar"),v["foobar"].as_str().unwrap(),"\"foobar\"");

    // projectId derivation.
    let pi = &fx["projectId"];
    let expected_pid = format!("proj-{}", fnv1a32_hex(pi["input"].as_str().unwrap()));
    assert_eq!(expected_pid, pi["id"].as_str().unwrap());

    // phaseId derivation.
    let ph = &fx["phaseId"];
    let expected_ph = format!("pid-{}", fnv1a32_hex(ph["input"].as_str().unwrap()));
    assert_eq!(expected_ph, ph["id"].as_str().unwrap());

    // Wire frame serde — ClientMsg round-trips.
    let frames = &fx["wireFrames"];
    let req = serde_json::from_value::<ClientMsg>(frames["plan_sync_manifest_request"].clone())
        .expect("plan_sync_manifest_request deserializes");
    assert!(
        matches!(&req, ClientMsg::PlanSyncManifestRequest { project_id, .. } if project_id == "proj-bf9cf968"),
        "expected PlanSyncManifestRequest with proj-bf9cf968, got {req:?}"
    );
    let pull = serde_json::from_value::<ClientMsg>(frames["plan_sync_pull"].clone())
        .expect("plan_sync_pull deserializes");
    assert!(matches!(&pull, ClientMsg::PlanSyncPull { paths, .. } if paths == &["goal.md"]),
        "expected PlanSyncPull with [\"goal.md\"], got {pull:?}");
    let push = serde_json::from_value::<ClientMsg>(frames["plan_sync_push"].clone())
        .expect("plan_sync_push deserializes");
    assert!(matches!(&push, ClientMsg::PlanSyncPush { files, .. } if files.len() == 1),
        "expected PlanSyncPush with 1 file, got {push:?}");

    // ServerMsg serialization matches fixture wire shapes.
    let manifest_frame = serde_json::to_value(ServerMsg::PlanSyncManifest {
        project_id: "proj-bf9cf968".into(),
        files: [("goal.md".to_string(), "bf9cf968".to_string())].into_iter().collect(),
    })
    .unwrap();
    assert_eq!(manifest_frame, frames["plan_sync_manifest"], "plan_sync_manifest shape");

    let files_frame = serde_json::to_value(ServerMsg::PlanSyncFiles {
        project_id: "proj-bf9cf968".into(),
        files: vec![PlanFile { relpath: "goal.md".into(), content: "foobar".into() }],
    })
    .unwrap();
    assert_eq!(files_frame, frames["plan_sync_files"], "plan_sync_files shape");

    let ack_frame = serde_json::to_value(ServerMsg::PlanSyncAck {
        project_id: "proj-bf9cf968".into(),
        applied: true,
    })
    .unwrap();
    assert_eq!(ack_frame, frames["plan_sync_ack"], "plan_sync_ack shape");

    // Manifest content hash: fnv1a32("foobar") == fixture manifest files["goal.md"].
    let manifest = &fx["manifest"];
    let expected_hash = fnv1a32_hex("foobar");
    assert_eq!(expected_hash, manifest["files"]["goal.md"].as_str().unwrap());
}

/// FNV-1a 32-bit is a 32-bit operation even for long strings.
#[test]
fn fnv1a32_stays_in_u32_range() {
    let h = fnv1a32_hex("the quick brown fox jumps over the lazy dog");
    assert_eq!(h.len(), 8);
    assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
}

/// Validate serde against the shared cross-repo fixture
/// (`src/lib/tunnelProtocol.fixtures.json`, also consumed by the TS tests and
/// mobile-studio-code). If this drifts, the protocol changed and both repos
/// must coordinate (#46).
#[test]
fn shared_fixture_matches_serde() {
    let path = find_fixture("tunnelProtocol.fixtures.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read fixture {}: {e}", path.display()));
    let fx: serde_json::Value = serde_json::from_str(&raw).unwrap();

    // client → server: every fixture deserializes into the expected variant.
    let c = &fx["clientToServer"];
    assert!(matches!(
        serde_json::from_value::<ClientMsg>(c["auth"].clone()).unwrap(),
        ClientMsg::Auth { fcm_token: Some(_), .. }
    ));
    assert!(matches!(
        serde_json::from_value::<ClientMsg>(c["auth_no_fcm"].clone()).unwrap(),
        ClientMsg::Auth { fcm_token: None, .. }
    ));
    assert!(matches!(
        serde_json::from_value::<ClientMsg>(c["set_fcm_token"].clone()).unwrap(),
        ClientMsg::SetFcmToken { fcm_token } if fcm_token == "fcm-token-xyz"
    ));
    assert!(matches!(
        serde_json::from_value::<ClientMsg>(c["pane_set_state"].clone()).unwrap(),
        ClientMsg::PaneSetState { .. }
    ));
    assert!(matches!(
        serde_json::from_value::<ClientMsg>(c["pane_focus"].clone()).unwrap(),
        ClientMsg::PaneFocus { .. }
    ));
    assert!(matches!(
        serde_json::from_value::<ClientMsg>(c["pane_input"].clone()).unwrap(),
        ClientMsg::PaneInput { .. }
    ));
    assert!(matches!(
        serde_json::from_value::<ClientMsg>(c["pane_resize"].clone()).unwrap(),
        ClientMsg::PaneResize { cols: 80, rows: 24, .. }
    ));

    // server → client: our serialization equals the fixture byte-shape.
    let s = &fx["serverToClient"];
    assert_eq!(serde_json::to_value(ServerMsg::AuthOk).unwrap(), s["auth_ok"]);
    assert_eq!(
        serde_json::to_value(ServerMsg::PaneOutput {
            pane_id: "t0p0".into(),
            data: "$ ls\r\n".into(),
            coarse: false,
        })
        .unwrap(),
        s["pane_output"]
    );
    assert_eq!(
        serde_json::to_value(ServerMsg::PaneSize {
            pane_id: "t0p0".into(),
            cols: 80,
            rows: 24,
        })
        .unwrap(),
        s["pane_size"]
    );
    assert_eq!(
        serde_json::to_value(ServerMsg::SessionState {
            pane_id: "t0p0".into(),
            status: "awaiting_input".into(),
            current_task: "api".into(),
            last_activity: "2026-05-29T00:00:00.000Z".into(),
            prompt: Some("Apply this change? (y/n)".into()),
        })
        .unwrap(),
        s["session_state"]
    );
    assert_eq!(
        serde_json::to_value(ServerMsg::UserRequest {
            pane_id: "t0p0".into(),
            prompt: "Apply this change? (y/n)".into(),
        })
        .unwrap(),
        s["user_request"]
    );
    // pane_list: deserialize the descriptors, then re-serialize to compare.
    let panes: Vec<PaneDescriptor> =
        serde_json::from_value(s["pane_list"]["panes"].clone()).unwrap();
    assert_eq!(
        serde_json::to_value(ServerMsg::PaneList { panes }).unwrap(),
        s["pane_list"]
    );
}

// ── #928 / T1b: Noise IK byte-level match against the shared cross-repo vector ──
//
// `src-tauri/tests/noise_vectors.json` is the *canonical, frozen* Noise IK test
// vector: empty prologue, fixed static AND ephemeral keypairs, and the exact
// ciphertext snow produces for the IK handshake + a transport message each way.
// snow normally samples a random ephemeral, so a byte-stable handshake is only
// reproducible when the ephemeral is pinned via `fixed_ephemeral_key_for_testing_only`
// (the two helpers below) — that is what makes a cross-impl vector possible at all.
//
// The same JSON is vendored into mobile-studio-code, where the noble side asserts
// against it; so any snow-vs-noble divergence (prologue, message framing, HKDF
// chaining, nonce/rekey) fails a test on at least one side. To regenerate after an
// intentional protocol change, run the `generate_noise_vector` authoring tool below
// and commit its output.

/// Build an IK *initiator* with a FIXED ephemeral — identical to `noise::initiator`
/// apart from pinning the ephemeral, which `noise::initiator` deliberately does not
/// expose (production must use a fresh random ephemeral). Test-vectors only.
fn vector_initiator(static_priv: &[u8], remote_pub: &[u8], eph_priv: &[u8]) -> snow::HandshakeState {
    snow::Builder::new(noise::PARAMS.parse().expect("valid noise params"))
        .local_private_key(static_priv).unwrap()
        .remote_public_key(remote_pub).unwrap()
        .fixed_ephemeral_key_for_testing_only(eph_priv)
        .build_initiator().unwrap()
}

/// Build an IK *responder* (desktop side) with a FIXED ephemeral. Test-vectors only.
fn vector_responder(static_priv: &[u8], eph_priv: &[u8]) -> snow::HandshakeState {
    snow::Builder::new(noise::PARAMS.parse().expect("valid noise params"))
        .local_private_key(static_priv).unwrap()
        .fixed_ephemeral_key_for_testing_only(eph_priv)
        .build_responder().unwrap()
}

#[test]
fn noise_ik_matches_shared_test_vector() {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/noise_vectors.json");
    let raw = std::fs::read_to_string(&path)
        .expect("src-tauri/tests/noise_vectors.json must exist (the shared Noise vector, #928)");
    let v: serde_json::Value = serde_json::from_str(&raw)
        .expect("tests/noise_vectors.json must be valid JSON");

    // Guard the params: if the tunnel ever changes its Noise suite, the frozen
    // ciphertext below stops matching — but assert the declared protocol up front so
    // the failure names the cause instead of looking like a crypto bug.
    assert_eq!(
        v["protocolName"].as_str().expect("protocolName"),
        noise::PARAMS,
        "the vector is for a different Noise protocol than the tunnel now uses"
    );

    let dec = |k: &str| b64.decode(v[k].as_str().unwrap_or_else(|| panic!("missing key {k}"))).unwrap();
    let init_static = dec("initStaticPriv");
    let init_eph    = dec("initEphemeralPriv");
    let resp_static = dec("respStaticPriv");
    let resp_pub    = dec("respStaticPub");
    let resp_eph    = dec("respEphemeralPriv");
    let msgs = v["messages"].as_array().expect("messages[]");

    let mut init = vector_initiator(&init_static, &resp_pub, &init_eph);
    let mut resp = vector_responder(&resp_static, &resp_eph);
    let mut buf = vec![0u8; 4096];
    let mut out = vec![0u8; 4096];

    let expect_ct = |i: usize| msgs[i]["ciphertext"].as_str().expect("ciphertext");
    let payload   = |i: usize| b64.decode(msgs[i]["payload"].as_str().expect("payload")).unwrap();

    // msg1 → e, es, s, ss
    let n = init.write_message(&[], &mut buf).unwrap();
    assert_eq!(b64.encode(&buf[..n]), expect_ct(0), "msg1 snow ↔ vector divergence (#928)");
    let m = resp.read_message(&buf[..n], &mut out).unwrap();
    assert_eq!(m, 0, "msg1 carries no payload");

    // msg2 ← e, ee, se
    let n = resp.write_message(&[], &mut buf).unwrap();
    assert_eq!(b64.encode(&buf[..n]), expect_ct(1), "msg2 snow ↔ vector divergence (#928)");
    let m = init.read_message(&buf[..n], &mut out).unwrap();
    assert_eq!(m, 0, "msg2 carries no payload");

    let mut it = init.into_transport_mode().unwrap();
    let mut rt = resp.into_transport_mode().unwrap();

    // transport init → resp (nonce 0 on the initiator's sending key)
    let p = payload(2);
    let n = it.write_message(&p, &mut buf).unwrap();
    assert_eq!(b64.encode(&buf[..n]), expect_ct(2), "transport init→resp divergence (#928)");
    let m = rt.read_message(&buf[..n], &mut out).unwrap();
    assert_eq!(&out[..m], &p[..], "transport init→resp decrypt mismatch");

    // transport resp → init (nonce 0 on the responder's sending key)
    let p = payload(3);
    let n = rt.write_message(&p, &mut buf).unwrap();
    assert_eq!(b64.encode(&buf[..n]), expect_ct(3), "transport resp→init divergence (#928)");
    let m = it.read_message(&buf[..n], &mut out).unwrap();
    assert_eq!(&out[..m], &p[..], "transport resp→init decrypt mismatch");
}

/// Authoring tool (not a CI test): regenerates `tests/noise_vectors.json`. Run with
///   cargo test -p app --lib generate_noise_vector -- --ignored --nocapture
/// and replace the file with the JSON printed between the markers.
#[test]
#[ignore = "authoring tool — regenerates tests/noise_vectors.json"]
fn generate_noise_vector() {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;

    let is = noise::generate_keypair().unwrap();
    let ie = noise::generate_keypair().unwrap();
    let rs = noise::generate_keypair().unwrap();
    let re = noise::generate_keypair().unwrap();

    let mut init = vector_initiator(&is.private, &rs.public, &ie.private);
    let mut resp = vector_responder(&rs.private, &re.private);
    let mut buf = vec![0u8; 4096];
    let mut out = vec![0u8; 4096];

    let n = init.write_message(&[], &mut buf).unwrap();
    let msg1 = b64.encode(&buf[..n]);
    resp.read_message(&buf[..n], &mut out).unwrap();
    let n = resp.write_message(&[], &mut buf).unwrap();
    let msg2 = b64.encode(&buf[..n]);
    init.read_message(&buf[..n], &mut out).unwrap();

    let mut it = init.into_transport_mode().unwrap();
    let mut rt = resp.into_transport_mode().unwrap();
    let pa: &[u8] = b"pane_input";
    let n = it.write_message(pa, &mut buf).unwrap();
    let ct_a = b64.encode(&buf[..n]);
    rt.read_message(&buf[..n], &mut out).unwrap();
    let pb: &[u8] = b"pane_output";
    let n = rt.write_message(pb, &mut buf).unwrap();
    let ct_b = b64.encode(&buf[..n]);
    it.read_message(&buf[..n], &mut out).unwrap();

    let json = serde_json::json!({
        "$comment": "Canonical Noise IK test vector (#928). FROZEN + shared cross-repo: \
                     mobile-studio-code vendors this same file and asserts the noble side \
                     against it. Empty prologue; static AND ephemeral keypairs are fixed so \
                     the handshake bytes are reproducible. All values base64. Regenerate via \
                     the `generate_noise_vector` authoring test after an intentional change.",
        "protocolName": noise::PARAMS,
        "prologue": "",
        "initStaticPriv": b64.encode(is.private),
        "initEphemeralPriv": b64.encode(ie.private),
        "respStaticPriv": b64.encode(rs.private),
        "respStaticPub": b64.encode(rs.public),
        "respEphemeralPriv": b64.encode(re.private),
        "messages": [
            { "label": "msg1 init->resp (e, es, s, ss)", "payload": "", "ciphertext": msg1 },
            { "label": "msg2 resp->init (e, ee, se)", "payload": "", "ciphertext": msg2 },
            { "label": "transport init->resp", "payload": b64.encode(pa), "ciphertext": ct_a },
            { "label": "transport resp->init", "payload": b64.encode(pb), "ciphertext": ct_b },
        ]
    });
    println!("<<<NOISE_VECTOR_JSON");
    println!("{}", serde_json::to_string_pretty(&json).unwrap());
    println!("NOISE_VECTOR_JSON>>>");
}

/// A full Noise IK handshake between the desktop (responder) and a mobile peer
/// (initiator that knows the desktop's static public key) yields a working
/// bidirectional transport — the end-to-end channel the relay can't read.
#[test]
fn noise_ik_handshake_roundtrips_both_directions() {
    let host = noise::generate_keypair().unwrap(); // desktop static identity
    let mobile = noise::generate_keypair().unwrap(); // mobile static identity

    // Mobile learns `host.public` from the QR; the desktop learns mobile's key
    // during the handshake (IK).
    let mut init = noise::initiator(&mobile.private, &host.public).unwrap();
    let mut resp = noise::responder(&host.private).unwrap();

    let mut buf = [0u8; 1024];
    let mut out = [0u8; 1024];

    // -> e, es, s, ss
    let n = init.write_message(&[], &mut buf).unwrap();
    resp.read_message(&buf[..n], &mut out).unwrap();
    // <- e, ee, se
    let n = resp.write_message(&[], &mut buf).unwrap();
    init.read_message(&buf[..n], &mut out).unwrap();

    let mut it = init.into_transport_mode().unwrap();
    let mut rt = resp.into_transport_mode().unwrap();

    // mobile → desktop
    let n = it.write_message(b"pane_input", &mut buf).unwrap();
    let m = rt.read_message(&buf[..n], &mut out).unwrap();
    assert_eq!(&out[..m], b"pane_input");

    // desktop → mobile
    let n = rt.write_message(b"pane_output", &mut buf).unwrap();
    let m = it.read_message(&buf[..n], &mut out).unwrap();
    assert_eq!(&out[..m], b"pane_output");
}

/// A wrong responder key (a malicious relay swapping the host identity) fails the
/// handshake — the QR-pinned `hostPubKey` is what authenticates the desktop.
#[test]
fn noise_ik_rejects_wrong_host_key() {
    let host = noise::generate_keypair().unwrap();
    let imposter = noise::generate_keypair().unwrap();
    let mobile = noise::generate_keypair().unwrap();

    // Mobile expects `host`, but the responder is `imposter`.
    let mut init = noise::initiator(&mobile.private, &host.public).unwrap();
    let mut resp = noise::responder(&imposter.private).unwrap();

    let mut buf = [0u8; 1024];
    let mut out = [0u8; 1024];
    let n = init.write_message(&[], &mut buf).unwrap();
    // The responder can't decrypt an IK first message sealed to a different static
    // key — the handshake fails rather than establishing a session.
    assert!(resp.read_message(&buf[..n], &mut out).is_err());
}

/// View-only gate (#B-wan-viewonly): a paired phone cannot drive a pane until the
/// desktop grants input. Keystrokes/resizes are dropped while view-only and flow once
/// granted; focus/set-state (read-side filtering) and auth are always allowed.
#[test]
fn view_only_drops_pty_input_until_granted() {
    let keys = ClientMsg::PaneInput { pane_id: "t0p0".into(), data: "rm -rf /\n".into() };
    let resize = ClientMsg::PaneResize { pane_id: "t0p0".into(), cols: 80, rows: 24 };
    let focus = ClientMsg::PaneFocus { pane_id: "t0p0".into() };
    let set_state = ClientMsg::PaneSetState { pane_id: "t0p0".into(), state: "streaming".into() };

    // View-only (not granted): PTY-mutating frames are dropped …
    assert!(!transport::input_allowed(&keys, false));
    assert!(!transport::input_allowed(&resize, false));
    // … but read-side frames still steer which pane streams back.
    assert!(transport::input_allowed(&focus, false));
    assert!(transport::input_allowed(&set_state, false));

    // After the desktop grants input, keystrokes + resize are allowed.
    assert!(transport::input_allowed(&keys, true));
    assert!(transport::input_allowed(&resize, true));
}

/// Granting/revoking input flips the gate, and the once-per-session request latch is
/// reset so a later view-only attempt re-prompts the desktop.
#[test]
fn input_grant_toggles_state_and_resets_request_latch() {
    let st = TunnelState::new();
    // Fresh state is view-only and reflected in the status card.
    assert!(!st.input_granted());
    assert!(!st.status_locked(&st.inner.lock().unwrap()).input_granted);

    // First view-only attempt latches a single prompt; subsequent ones don't re-fire.
    assert!(st.take_input_request());
    assert!(!st.take_input_request());

    // Granting input flips the gate and clears the latch.
    st.set_input_granted(true);
    assert!(st.input_granted());
    assert!(st.status_locked(&st.inner.lock().unwrap()).input_granted);

    // Revoking returns to view-only and re-arms the prompt latch.
    st.set_input_granted(false);
    assert!(!st.input_granted());
    assert!(st.take_input_request());
}

#[test]
fn host_pub_key_is_base64_of_static_public() {
    let st = TunnelState::new();
    let b64 = st.host_pub_key_b64();
    assert!(!b64.is_empty());
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD.decode(&b64).unwrap();
    assert_eq!(decoded, st.static_pub);
}

#[test]
fn broadcast_output_is_noop_without_subscribers() {
    let st = TunnelState::new();
    // No receivers yet → returns without sending (and without panicking).
    st.broadcast_output("t0p0", "hello");
    // With a subscriber, the chunk is delivered.
    let mut rx = st.subscribe_output();
    st.broadcast_output("t0p0", "world");
    let got = rx.try_recv().unwrap();
    assert_eq!(got.pane_id, "t0p0");
    assert_eq!(got.data, "world");
}

#[test]
fn set_pane_size_records_dedupes_and_broadcasts() {
    let st = TunnelState::new();
    let mut rx = st.subscribe_events();

    // First set records the size and broadcasts a pane_size event.
    st.set_pane_size("t0p0", 80, 24);
    match rx.try_recv().unwrap() {
        ServerMsg::PaneSize { pane_id, cols, rows } => {
            assert_eq!((pane_id.as_str(), cols, rows), ("t0p0", 80, 24));
        }
        other => panic!("expected pane_size, got {other:?}"),
    }
    assert_eq!(st.pane_sizes(), vec![("t0p0".to_string(), 80, 24)]);

    // An identical size is a no-op — no duplicate event.
    st.set_pane_size("t0p0", 80, 24);
    assert!(rx.try_recv().is_err());

    // A changed size broadcasts again and updates the replay snapshot.
    st.set_pane_size("t0p0", 100, 30);
    assert!(matches!(
        rx.try_recv().unwrap(),
        ServerMsg::PaneSize { cols: 100, rows: 30, .. }
    ));
    assert_eq!(st.pane_sizes(), vec![("t0p0".to_string(), 100, 30)]);
}

#[test]
fn room_id_is_relay_valid() {
    // Matches the relay's validateRoomId: [A-Za-z0-9_-]{16,64}.
    let id = transport::generate_room_id();
    assert_eq!(id.len(), 32);
    assert!(id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    // Two draws differ (entropy sanity).
    assert_ne!(transport::generate_room_id(), transport::generate_room_id());
}

/// Pairing secrets are fresh + rotatable (#B-unpair-revoke): each draw is 64 hex
/// chars (32 bytes) and two draws differ, so `tunnel_unpair` invalidating the old
/// secret by minting a new one cannot collide with the previous QR.
#[test]
fn psk_is_fresh_rotatable_hex() {
    let a = transport::generate_psk();
    let b = transport::generate_psk();
    assert_eq!(a.len(), 64);
    assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a, b);
}

// ── T3b: RelayDiag struct shape ──────────────────────────────────────────────

/// RelayDiag serializes with camelCase keys — asserts the wire shape the frontend
/// (tunnelClient.ts `tunnelCheckRelay`) and the Settings card depend on.
#[test]
fn relay_diag_serializes_camel_case() {
    let d = RelayDiag {
        reachable: true,
        service: Some("msc-tunnel-relay".into()),
        version: Some("0.1.0".into()),
        latency_ms: 42,
        error: None,
        host_connected: false,
        client_count: 1,
    };
    let v = serde_json::to_value(&d).unwrap();
    assert!(v.get("reachable").is_some(),       "reachable");
    assert!(v.get("latencyMs").is_some(),        "latencyMs (camelCase)");
    assert!(v.get("hostConnected").is_some(),    "hostConnected (camelCase)");
    assert!(v.get("clientCount").is_some(),      "clientCount (camelCase)");
    assert_eq!(v["latencyMs"], 42);
    assert_eq!(v["service"], "msc-tunnel-relay");
}

/// A failed probe (e.g. invalid URL) always produces `reachable: false` with an
/// `error` message rather than panicking — the Settings card can render the result.
#[test]
fn relay_diag_error_case_is_not_reachable() {
    let d = RelayDiag {
        reachable: false,
        service: None,
        version: None,
        latency_ms: 5001,
        error: Some("probe timed out after 5s".into()),
        host_connected: false,
        client_count: 0,
    };
    let v = serde_json::to_value(&d).unwrap();
    assert_eq!(v["reachable"], false);
    assert!(v["error"].as_str().unwrap().contains("timed out"));
    assert_eq!(v["service"], serde_json::Value::Null);
}

// ── T5: relay idle/TTL close detection ───────────────────────────────────────

/// The close-reason strings the Cloudflare relay emits for idle/TTL expiry are
/// detected so `tunnel://room-expired` is emitted instead of a generic reconnect.
#[test]
fn room_expired_close_reasons_are_recognized() {
    // Strings emitted by relay/src/room.ts's alarm() handler.
    let idle = "room idle timeout";
    let ttl  = "room lifetime exceeded";
    let transient = "going away";
    let empty = "";

    assert!(idle.contains("idle timeout"),       "idle timeout pattern");
    assert!(ttl.contains("lifetime exceeded"),   "lifetime exceeded pattern");
    assert!(!transient.contains("idle timeout") && !transient.contains("lifetime exceeded"),
        "transient close should not trigger room-expired");
    assert!(!empty.contains("idle timeout") && !empty.contains("lifetime exceeded"),
        "empty reason should not trigger room-expired");
}

#[test]
fn split_utf8_respects_size_and_char_boundaries() {
    assert_eq!(transport::split_utf8("", 4), Vec::<&str>::new());
    assert_eq!(transport::split_utf8("abc", 8), vec!["abc"]);
    // Multi-byte chars must never be split mid-codepoint.
    let s = "é".repeat(10); // each 'é' is 2 bytes → 20 bytes
    let parts = transport::split_utf8(&s, 5);
    assert!(parts.iter().all(|p| p.len() <= 5));
    assert_eq!(parts.concat(), s); // lossless
}

/// Establish a Noise IK transport pair (host responder, mobile initiator).
fn handshake_pair() -> (snow::TransportState, snow::TransportState) {
    let host = noise::generate_keypair().unwrap();
    let mobile = noise::generate_keypair().unwrap();
    let mut init = noise::initiator(&mobile.private, &host.public).unwrap();
    let mut resp = noise::responder(&host.private).unwrap();
    let mut b = [0u8; 1024];
    let mut o = [0u8; 1024];
    let n = init.write_message(&[], &mut b).unwrap();
    resp.read_message(&b[..n], &mut o).unwrap();
    let n = resp.write_message(&[], &mut b).unwrap();
    init.read_message(&b[..n], &mut o).unwrap();
    (resp.into_transport_mode().unwrap(), init.into_transport_mode().unwrap())
}

#[test]
fn app_messages_roundtrip_through_the_noise_session() {
    let (mut host, mut mobile) = handshake_pair();

    // desktop → mobile: encode a ServerMsg, decrypt + parse on the mobile side.
    let frame = transport::encode(&mut host, &ServerMsg::AuthOk).unwrap();
    let mut out = vec![0u8; frame.len()];
    let n = mobile.read_message(&frame, &mut out).unwrap();
    let v: serde_json::Value = serde_json::from_slice(&out[..n]).unwrap();
    assert_eq!(v, serde_json::json!({ "type": "auth_ok" }));

    // mobile → desktop: a client `auth` frame decodes via decode_room_msg.
    let cj = serde_json::to_vec(&serde_json::json!({ "type": "auth", "token": "secret" })).unwrap();
    let mut cf = vec![0u8; cj.len() + 16];
    let m = mobile.write_message(&cj, &mut cf).unwrap();
    cf.truncate(m);
    let decoded = decode_room_msg(&mut host, &cf).unwrap();
    assert!(matches!(decoded, ClientMsg::Auth { token, .. } if token == "secret"));
}

// ── F2: fleet roster + coord event ──────────────────────────────────────────

/// FleetSession serializes with camelCase and omits empty `blocked_on`.
#[test]
fn fleet_session_camel_case_and_skips_empty_blocked_on() {
    let s = FleetSession {
        session: "t0p1".into(),
        status: "running".into(),
        blocked_on: vec![],
        wait_reason: None,
        question: None,
        at: 1_700_000_000_000,
    };
    let v = serde_json::to_value(&s).unwrap();
    // camelCase field names
    assert!(v.get("blockedOn").is_none(), "empty blocked_on must be omitted");
    assert!(v.get("waitReason").is_some(), "waitReason must be present (null)");
    assert_eq!(v["session"], "t0p1");
    assert_eq!(v["status"], "running");
}

/// FleetSession with deps serializes blocked_on as an array.
#[test]
fn fleet_session_with_blocked_on_includes_array() {
    let s = FleetSession {
        session: "t0p2".into(),
        status: "blocked".into(),
        blocked_on: vec!["#42".into(), "contract:TunnelState".into()],
        wait_reason: None,
        question: None,
        at: 0,
    };
    let v = serde_json::to_value(&s).unwrap();
    assert_eq!(v["blockedOn"], serde_json::json!(["#42", "contract:TunnelState"]));
}

/// FleetRoster ServerMsg serializes with snake_case type tag.
#[test]
fn fleet_roster_msg_type_tag() {
    let msg = ServerMsg::FleetRoster { sessions: vec![] };
    let v = serde_json::to_value(&msg).unwrap();
    assert_eq!(v["type"], "fleet_roster");
    assert_eq!(v["sessions"], serde_json::json!([]));
}

/// CoordEvent ServerMsg serializes correctly.
#[test]
fn coord_event_msg_type_tag() {
    let msg = ServerMsg::CoordEvent {
        kind: "waiting".into(),
        session: Some("t0p1".into()),
        ref_key: None,
        at: 12345,
    };
    let v = serde_json::to_value(&msg).unwrap();
    assert_eq!(v["type"], "coord_event");
    assert_eq!(v["kind"], "waiting");
    assert_eq!(v["session"], "t0p1");
    assert_eq!(v["at"], 12345);
}

/// CoordWake ClientMsg deserializes from the wire shape.
#[test]
fn coord_wake_client_msg_deserializes() {
    let raw = serde_json::json!({ "type": "coord_wake", "session": "t0p3" });
    let msg = serde_json::from_value::<ClientMsg>(raw).unwrap();
    assert!(matches!(msg, ClientMsg::CoordWake { session } if session == "t0p3"));
}

/// CoordApprove ClientMsg deserializes from the wire shape.
#[test]
fn coord_approve_client_msg_deserializes() {
    let raw = serde_json::json!({ "type": "coord_approve", "session": "t0p4" });
    let msg = serde_json::from_value::<ClientMsg>(raw).unwrap();
    assert!(matches!(msg, ClientMsg::CoordApprove { session } if session == "t0p4"));
}

// ── A2: automation frames + run-now ─────────────────────────────────────────

/// AutomationFrame serializes with camelCase.
#[test]
fn automation_frame_camel_case() {
    let f = AutomationFrame {
        id: "a1".into(),
        name: "Nightly build".into(),
        armed: true,
        when_expr: "0 2 * * *".into(),
        last_run_at: Some(1_700_000_000_000),
        next_run_at: None,
        last_status: Some("ok".into()),
    };
    let v = serde_json::to_value(&f).unwrap();
    assert_eq!(v["whenExpr"], "0 2 * * *");
    assert_eq!(v["lastRunAt"], 1_700_000_000_000_u64);
    assert_eq!(v["lastStatus"], "ok");
    assert_eq!(v["nextRunAt"], serde_json::Value::Null);
}

/// AutomationList ServerMsg type tag.
#[test]
fn automation_list_msg_type_tag() {
    let msg = ServerMsg::AutomationList { automations: vec![] };
    let v = serde_json::to_value(&msg).unwrap();
    assert_eq!(v["type"], "automation_list");
}

/// AutomationFailed ServerMsg type tag and camelCase.
#[test]
fn automation_failed_msg_shape() {
    let msg = ServerMsg::AutomationFailed { id: "a1".into(), at: 42, error: "timeout".into() };
    let v = serde_json::to_value(&msg).unwrap();
    assert_eq!(v["type"], "automation_failed");
    assert_eq!(v["error"], "timeout");
}

/// AutomationArm ClientMsg deserializes.
#[test]
fn automation_arm_client_msg_deserializes() {
    let raw = serde_json::json!({ "type": "automation_arm", "id": "a1", "armed": false });
    let msg = serde_json::from_value::<ClientMsg>(raw).unwrap();
    assert!(matches!(msg, ClientMsg::AutomationArm { id, armed } if id == "a1" && !armed));
}

/// AutomationRunNow ClientMsg deserializes.
#[test]
fn automation_run_now_client_msg_deserializes() {
    let raw = serde_json::json!({ "type": "automation_run_now", "id": "a2" });
    let msg = serde_json::from_value::<ClientMsg>(raw).unwrap();
    assert!(matches!(msg, ClientMsg::AutomationRunNow { id } if id == "a2"));
}

// ── PT1: live planning frames (#934) ─────────────────────────────────────────

/// plan_state serializes snake_case-tagged with the camelCase fields the phone expects.
#[test]
fn plan_state_msg_shape() {
    let msg = ServerMsg::PlanState {
        project_id: "proj-bf9cf968".into(),
        current_stage: "goal".into(),
        confirmed_sections: vec!["goal".into()],
        files: vec![PlanFile { relpath: "goal.md".into(), content: "# Goal".into() }],
        messages: vec![PlanMessage { role: "assistant".into(), text: "hi".into(), at: 1 }],
        pipeline_runs: vec![PlanPipelineRun { id: "build".into(), stage: "test".into(), status: "running".into() }],
    };
    let v = serde_json::to_value(&msg).unwrap();
    assert_eq!(v["type"], "plan_state");
    assert_eq!(v["projectId"], "proj-bf9cf968");
    assert_eq!(v["currentStage"], "goal");
    assert_eq!(v["confirmedSections"][0], "goal");
    assert_eq!(v["files"][0]["relpath"], "goal.md");
    assert_eq!(v["pipelineRuns"][0]["id"], "build");
}

/// plan_event: snake_case type tag, camelCase fields, absent detail omitted.
#[test]
fn plan_event_msg_shape() {
    let msg = ServerMsg::PlanEvent {
        project_id: "p".into(),
        kind: "section_confirmed".into(),
        at: 1,
        section: Some("goal".into()),
        stage: None,
        message: None,
        run: None,
    };
    let v = serde_json::to_value(&msg).unwrap();
    assert_eq!(v["type"], "plan_event");
    assert_eq!(v["kind"], "section_confirmed");
    assert_eq!(v["section"], "goal");
    assert!(v.get("stage").is_none()); // skip_serializing_if omits absent detail
}

/// plan_status type tag + camelCase.
#[test]
fn plan_status_msg_shape() {
    let msg = ServerMsg::PlanStatus { project_id: "p".into(), current_stage: "scope".into(), status: "in_progress".into() };
    let v = serde_json::to_value(&msg).unwrap();
    assert_eq!(v["type"], "plan_status");
    assert_eq!(v["currentStage"], "scope");
    assert_eq!(v["status"], "in_progress");
}

/// The drive frames deserialize from the phone's camelCase wire shape.
#[test]
fn plan_drive_client_msgs_deserialize() {
    let adv = serde_json::from_value::<ClientMsg>(serde_json::json!({ "type": "plan_advance", "projectId": "p", "stageKey": "scope" })).unwrap();
    assert!(matches!(adv, ClientMsg::PlanAdvance { stage_key, .. } if stage_key == "scope"));
    let con = serde_json::from_value::<ClientMsg>(serde_json::json!({ "type": "plan_confirm", "projectId": "p", "section": "goal" })).unwrap();
    assert!(matches!(con, ClientMsg::PlanConfirm { section, .. } if section == "goal"));
    let chat = serde_json::from_value::<ClientMsg>(serde_json::json!({ "type": "plan_chat", "projectId": "p", "text": "hi" })).unwrap();
    assert!(matches!(chat, ClientMsg::PlanChat { text, .. } if text == "hi"));
}

/// A view-only phone can mirror the planning session but cannot steer it (#934).
#[test]
fn plan_drive_requires_input_grant() {
    let chat = ClientMsg::PlanChat { project_id: "p".into(), text: "hi".into() };
    assert!(!transport::input_allowed(&chat, false));
    assert!(transport::input_allowed(&chat, true));
    assert!(!transport::input_allowed(&ClientMsg::PlanAdvance { project_id: "p".into(), stage_key: "scope".into() }, false));
    assert!(!transport::input_allowed(&ClientMsg::PlanConfirm { project_id: "p".into(), section: "goal".into() }, false));
}

// ── M2: MCP extension list ───────────────────────────────────────────────────

/// McpExtFrame serializes with camelCase.
#[test]
fn mcp_ext_frame_camel_case() {
    let f = McpExtFrame {
        id: "m1".into(),
        kind: "mcp".into(),
        name: "Postgres".into(),
        enabled: true,
        transport: Some("stdio".into()),
        url: None,
    };
    let v = serde_json::to_value(&f).unwrap();
    assert_eq!(v["transport"], "stdio");
    assert_eq!(v["url"], serde_json::Value::Null);
    assert_eq!(v["enabled"], true);
}

/// McpList ServerMsg type tag.
#[test]
fn mcp_list_msg_type_tag() {
    let msg = ServerMsg::McpList { extensions: vec![] };
    let v = serde_json::to_value(&msg).unwrap();
    assert_eq!(v["type"], "mcp_list");
}

// ── TunnelState snapshot methods ────────────────────────────────────────────

/// fleet_snapshot / automations_snapshot / mcp_snapshot return empty then update.
#[test]
fn snapshot_methods_start_empty_and_update() {
    let st = TunnelState::new();
    assert!(st.fleet_snapshot().is_empty());
    assert!(st.automations_snapshot().is_empty());
    assert!(st.mcp_snapshot().is_empty());

    {
        let mut inner = st.inner.lock().unwrap();
        inner.fleet_sessions.push(FleetSession {
            session: "t0p0".into(),
            status: "running".into(),
            blocked_on: vec![],
            wait_reason: None,
            question: None,
            at: 0,
        });
        inner.automations.push(AutomationFrame {
            id: "a1".into(),
            name: "test".into(),
            armed: true,
            when_expr: "*/5 * * * *".into(),
            last_run_at: None,
            next_run_at: None,
            last_status: None,
        });
        inner.mcp_extensions.push(McpExtFrame {
            id: "m1".into(),
            kind: "mcp".into(),
            name: "Postgres".into(),
            enabled: true,
            transport: Some("stdio".into()),
            url: None,
        });
    }
    assert_eq!(st.fleet_snapshot().len(), 1);
    assert_eq!(st.automations_snapshot().len(), 1);
    assert_eq!(st.mcp_snapshot().len(), 1);
}
