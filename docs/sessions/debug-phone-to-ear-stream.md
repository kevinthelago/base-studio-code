# Debug session — getting the phone's microphone into the ear

> **SESSION ARTIFACT — not maintained.** A record of one debug session (2026-09-12), kept so the
> method and the mistakes can be re-reviewed. It was true when written. The durable references are
> the plan item `one-pairing-assigns-every-room`, its change record (`bsc plan change render`), and
> the follow-up items named at the bottom.
> See [`README.md`](README.md) for why this lives here.

The goal was narrow and practical: make a phone's microphone actually reach `bsc ear`, rather than
appear to. The session is recorded because **most of what it cost was method, not code** — five of
the mistakes below produced *green* results that looked like evidence.

The debug session itself ran **external to the app**, deliberately (maintainer, this session): a
session that has to observe a launch or a keychain cannot live inside the process it is observing.

## The bug, and the blocker that was not in the brief

The measured failure: a phone paired from the app's Settings QR streamed audio for minutes and
nothing received it. The app decoded every `AudioFrame` and emitted `tunnel://audio-frame`, which
**zero** modules listen for; meanwhile the ear — the only real consumer — sat in a different room.

The brief framed the fix as "the QR carries a seed, so one pairing reaches every room". That is
necessary and was **not sufficient**. Two things were still wrong and neither was in the brief:

1. **Two seeds.** The app stored `tunnel-pairing-seed`; `bsc ear` stored `ear-tunnel-identity` with
   its own. So the phone derived `room("ear")` from the *app's* seed while the ear hosted a room
   derived from *its own*. Different seeds name different rooms; the phone joined one nobody hosted.
2. **Two keypairs.** The QR carries exactly ONE host public key, which the phone pins as the Noise
   IK remote static. Two processes with two keypairs cannot both be authenticated by it.

Both collapse into acceptance criterion 4 — *one durable machine identity* — which the brief treated
as a restart nicety. It is **load-bearing for one-QR-many-rooms**, and nothing could work until it
landed. That is the single most useful finding of the session.

## What landed

| | |
|---|---|
| Slice 1 | The ear's identity derives from a seed; a seedless one still pairs (migration) |
| Slice 2 | The app reuses a durable seed — only `tunnel_unpair` rotates, not a restart |
| Slice 3 | `B2*<HOST>*<PK>*<SEED>` on the wire, in Rust, desktop-TS and mobile-TS; B1 + JSON still accepted |
| Slice 4 | The app stops swallowing audio into a listener-less event |
| Step A | **One machine identity** in `bsc-secret`, shared by the app and the ear |
| Step B | The phone opens a *second* connection into the ear's room and streams audio there |
| Step C | The phone says *which* host is missing — "the ear isn't running", naming `bsc ear room` |

`MachineIdentity` went into `bsc-secret` because both `src-tauri` and `bsc-ear` already depend on
it — **zero new dependency edges**, where `bsc-tunnel` would have meant a `keyring` edge in the crate
that holds the wire contract. It owns storage, load order, the legacy promotion and the
write-then-read-back guard; the crypto is injected as `Minted`, so `bsc-secret` needs no base64,
rand or snow.

Unpairing rotates the **seed** and keeps the **keypair**: new rooms kill the old QR, while the pinned
key stays put so one QR still authenticates both hosts.

## Nine method lessons, each of which cost real time

The through-line: **a green result is not evidence.** Every item here first appeared as a pass.

1. **A red-proof needs BOTH legs.** Red-with-the-defect alone proves nothing; it must also go GREEN
   with the defect absent. A guard of mine failed *identically* in both states and I nearly filed
   that as proof.
2. **`cargo nextest` fail-fasts by default.** Breaking one function to prove two guards returned
   "21 of 54 run, 1 failed" — the second guard never executed. `--no-fail-fast` or you prove only
   the first.
3. **A source-scanning test can match its own source.** A guard reading the generated crate matched
   its own `l.contains("…")` call and assert message. Split the needle (`concat!`) so the literal
   never appears on one line of the test.
4. **A substitution that does not match reports success.** A mutation that silently applied nothing
   left the suite green, which is indistinguishable from a guard that does not bite. Assert the
   **intended token is present AND the old one is gone** — and read the real text with `grep` before
   writing the pattern rather than guessing it.
5. **`git checkout -- <file>` destroyed uncommitted work.** The reasoning "the file is committed, so
   the restore is exact" was true for an earlier red-proof in that same file and false once two
   uncommitted functions had been added. **Committed is not unmodified.** During an experiment, copy
   the file aside and restore with `cp`; a record-store red-proof already works that way.
6. **`length()` in SQLite counts CHARACTERS, not bytes.** A carried test read 23,474 against a
   23,595-byte snapshot and looked like a truncated write. The 121 delta was multi-byte UTF-8 in
   comments. Settled by diffing content, not by trusting the number.
7. **An empty grep is not evidence of absence.** Scoped to `src/`, it looked like nothing consumed
   the mic state; the screens live in `app/` (Expo Router) and one renders the whole surface.
8. **Record facets go stale, and only the relationship gate sees it.** `crateDeps` caught it three
   times on this branch (`sha2`, then `bsc_secret`/`tauri`, then a missing `composes` edge). Adding a
   crate to a record is **two** writes — the manifest record and the record's `crateDeps` facet — and
   the compiler checks only one.
9. **A binary record-store merge needs the side VERIFIED, not reasoned.** `ours`/`theirs` flips with
   merge direction. Resolution here: take the side holding the other party's records (confirmed by
   **record count**, 3064 not 3058), then re-apply your own bodies with `impl set --repo`, then
   byte-compare every one against a pre-merge snapshot.

## What was verified, and what was not

Verified: 251 Rust tests (`bsc-ear` + `bsc-secret`), 55 desktop tunnel tests, 178 mobile tests, 167
desktop vitest, typecheck and clippy clean, relationship leg clean, and a full unscoped gate with
**0 unexplained** reds (three standing known-reds, each confirmed pre-existing and owned elsewhere).
Every new guard red-proofed both ways.

**Not verified: the stream itself.** At the time of writing no phone had streamed into a live
`bsc ear room` through this path. Three things gate that, and each needs the maintainer:

- the ear needs a `bsc` built from this work (the staged binary predates it and still loads the old
  per-ear identity);
- the app needs main to move and a restart, to pick up the new state record;
- the phone needs an EAS build/update — TestFlight 28 carries the B1 decoder, not the B2 decoder,
  the ear client, or the new mic surface.

The first real run is also the first test of three things no unit test reaches: whether the relay
accepts **two guests from one device** inside `MAX_GUESTS = 3`; whether the ear's reassembler accepts
a connection-scoped sequence from a phone that also holds a console session; and whether the shared
keychain identity resolves **identically from two processes** on one machine — the crux of step A and
the only part of it an in-memory vault cannot prove.

## Outstanding

- `the-phone-joins-a-feature-room-only-when-it-wants-that-feature` — criterion 5 is unimplemented:
  the phone joins the ear room unconditionally, costing a traffic-free websocket and one of three
  relay guest slots. The fix collides with the mic-stop guard, so it is a design decision about what
  `startMic` means.
- `a-tauri-event-with-no-listener-is-a-void-and-nothing-catches-it` — the class behind the original
  bug. One event is pinned; no gate asks the general question, and the hard part is the exemption
  list rather than the scan.
