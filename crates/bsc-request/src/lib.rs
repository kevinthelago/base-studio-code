//! The **improvement-request** store (#3295, epic #3260) — the designer→debug channel. A session confined
//! to `bsc ui` files a discrete request when the surface can't do what it needs; a full-capability debug
//! session reads the open queue, fixes the tooling, and resolves it. Requests are **contractual** — each
//! stands alone with a status, and no transcript is piped anywhere (unlike `bsc loop`, which is a running
//! conversation). The `cmd` field is the GROUNDING: the exact command that failed, so the ask is observed,
//! not narrated.
//!
//! Tauri-free on purpose (like `plandb`/`errordb`/`bsc-loop`): the umbrella `bsc` binary, the desktop app,
//! and any session all depend on it, so the CLI stays a tiny binary.


use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

/// The tool surface a request defaults to when none is given — today every request is a `bsc ui` gap; the
/// column lets the store grow to other surfaces without a migration.
pub const DEFAULT_SURFACE: &str = "bsc ui";

/// One improvement request — the `requests` row.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Request {
    pub id: i64,
    pub text: String,
    pub surface: String,
    /// The exact command that failed — the grounding (a request is observed, not narrated).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cmd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shot_path: Option<String>,
    /// `open` (claimable), `claimed` (a session is working it, #3535), or `resolved`.
    pub status: String,
    /// What the debug session changed, stamped on `resolve`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<i64>,
    /// WHICH session holds a claimed request — its pane id (#3535). Null unless `status = claimed`. Lets
    /// the pool tell a busy session (has a claim) from an idle one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed_by: Option<String>,
    /// When the request was claimed (epoch ms). Null unless claimed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed_at: Option<i64>,
    /// WHO filed it — the filing session's pane id (#debug-request-carries-its-origin), stamped by
    /// `bsc request new` from `$BSC_AUDIT_PANE`. `designer-studio:react`, `librarian-studio:typescript`,
    /// `myproject:director`, … Null when nothing filed it from a session, which is deliberate: a
    /// fabricated attribution is worse than an absent one, and the graph hangs a request's debug session
    /// off this node.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// The EXPLICIT short name, when one was given (`--title`). Null on a legacy row and on any request
    /// filed without the flag — read {@link Request::display_title} instead, which is always populated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// WHO filed it, as a RESOLVABLE PANE ID (`a-request-records-where-it-actually-came-from`) — stamped
    /// from `$BSC_AUDIT_PANE`, never typed. This is the only field the Glance graph can draw an edge
    /// from, because it is the only one that names a node.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_pane: Option<String>,
    /// WHO filed it, as a free-text ACTOR — what `--from` names (`claude`, `lane-c4`,
    /// `princess-bubblegum (dev session)`). A real identity that is simply not a node, which is why it
    /// is a separate column: one field holding either kind could only be told apart by looking for a
    /// `:` in the string, and that heuristic calls `lane-c4` a pane.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_actor: Option<String>,
    /// WHICH KIND of origin this row actually holds — `pane`, `actor`, `both`, `unknown` or `absent`.
    /// ALWAYS present, computed at row-decode ([`row_to_request`]) rather than stored, so every reader
    /// gets one answer and none of them re-derives it from the string's shape.
    ///
    /// `unknown` is the one that matters and is not a bug: a row filed before the split carries only
    /// the merged `origin`, and nothing recorded which kind it was. Saying so is the honest record —
    /// promoting it into `pane` or `actor` on a guess is exactly what this replaced.
    pub origin_kind: OriginKind,
    /// The directory `bsc request new` ran in. Absent when it could not be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// The repository (the main working tree). Absent for a filing outside any repository — never the
    /// process cwd standing in for one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// The WORKING TREE the filer was in — differs from `repo` in a linked worktree, which is the
    /// distinction that makes a `wt-131` report and a repo-root report different observations.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    /// The checked-out branch. Absent on a detached HEAD: a sha is not a branch name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The `bsc` crate version that filed it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bsc_version: Option<String>,
    /// When that binary was built (epoch ms) — the same signal `bsc version` prints. Half the queue
    /// reports behaviour that has since changed, and this is what makes "is this still true?" askable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bsc_built_at: Option<i64>,
    /// The agent harness driving the filer (`claude-code`, `bsc-agent`). Absent for a plain shell.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    /// The model, provider-namespaced when known (`local/qwen3-35b`). Absent far more often than not —
    /// Claude Code publishes no model unless pinned — and that absence is the correct record.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The harness's own session id, so a request can be read back against that session's transcript.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// The title to SHOW — the explicit `title` when there is one, else derived from `text`. ALWAYS
    /// present, so every consumer (the graph node label above all) has a non-empty label without
    /// reimplementing the fallback, and a legacy row needs no backfill.
    ///
    /// Computed at row-decode ([`row_to_request`]), never stored: freezing the derivation into the row
    /// would mean improving it later left every existing request on the old one.
    pub display_title: String,
}

/// WHAT KIND of thing a request's origin names (`a-request-records-where-it-actually-came-from`).
///
/// The store classifies it ONCE, from which columns are populated, so no reader has to. That is the
/// whole point: the previous single `origin` column mixed a resolvable pane id with arbitrary free
/// text, and every consumer that wanted to tell them apart reached for the same broken heuristic —
/// "does it contain a colon" — which labels `lane-c4` a pane and would label a pane id typed into
/// `--from` a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OriginKind {
    /// A session filed it and stamped its pane id — the graph can edge this to a node.
    Pane,
    /// A named actor filed it from a shell. A real identity, but not a node on any graph.
    Actor,
    /// A session that ALSO named an actor. Strictly more information than either alone; the pane is
    /// what the graph draws from.
    Both,
    /// A row filed before the split: the merged `origin` holds *something* and nothing recorded which
    /// kind it was. Deliberately not resolved by inspecting the string — see the type doc.
    Unknown,
    /// Nobody said. The one state that must never be filled in with a plausible guess.
    Absent,
}

impl OriginKind {
    /// Classify from the three columns, in the order the store populates them.
    pub fn of(pane: Option<&str>, actor: Option<&str>, legacy_origin: Option<&str>) -> OriginKind {
        fn live(v: Option<&str>) -> bool {
            v.map(str::trim).is_some_and(|s| !s.is_empty())
        }
        match (live(pane), live(actor)) {
            (true, true) => OriginKind::Both,
            (true, false) => OriginKind::Pane,
            (false, true) => OriginKind::Actor,
            // Only now does the merged column matter, and only to say we cannot tell.
            (false, false) if live(legacy_origin) => OriginKind::Unknown,
            (false, false) => OriginKind::Absent,
        }
    }

    /// Does this origin name a node the graph could edge to? `Unknown` says yes-maybe: the legacy
    /// string may or may not be a pane id, so a caller should TRY to resolve it and fall back to an
    /// unparented node — never skip it on the assumption it belongs to another graph.
    pub fn names_a_pane(self) -> bool {
        matches!(self, OriginKind::Pane | OriginKind::Both)
    }

    /// The word `get` prints and `--json` carries.
    pub fn as_str(self) -> &'static str {
        match self {
            OriginKind::Pane => "pane",
            OriginKind::Actor => "actor",
            OriginKind::Both => "both",
            OriginKind::Unknown => "unknown",
            OriginKind::Absent => "absent",
        }
    }
}

/// The longest derived title — long enough to carry a real phrase, short enough for a graph node label.
const TITLE_MAX: usize = 48;

impl Request {
    /// Claimable — not yet taken by a session, not resolved.
    pub fn is_open(&self) -> bool {
        self.status == "open"
    }
    /// Held by a session that is working it (#3535).
    pub fn is_claimed(&self) -> bool {
        self.status == "claimed"
    }
}

/// Derive a short title from a request's `text` (#debug-request-carries-its-origin).
///
/// `text` is the full narration — routinely a sentence or a paragraph — and a graph node needs a phrase.
/// Take the first sentence when one ends early enough, else the first {@link TITLE_MAX} characters cut at
/// a WORD boundary so a label never ends mid-word. Whitespace (including the newlines a shell heredoc
/// leaves) collapses to single spaces first, since a label is one line.
///
/// Never returns empty for non-empty input, and returns `"(untitled)"` for input that is empty or all
/// whitespace — a request with no text is a corrupt row, and a blank label would render as a nameless
/// node rather than a visibly broken one.
pub fn derive_title(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return "(untitled)".to_string();
    }
    // A sentence end that lands inside the budget is the best title the text offers.
    //
    // `TITLE_MAX + 1` chars are examined, not `TITLE_MAX`: the head is everything BEFORE the mark, so a
    // mark at index TITLE_MAX yields a head of exactly TITLE_MAX — at budget, not over it. Taking only
    // TITLE_MAX dropped that case to the eliding branch, which is a whole sentence lost to an ellipsis.
    if let Some(end) = flat.char_indices().take(TITLE_MAX + 1).find(|(_, c)| matches!(c, '.' | '!' | '?')) {
        let head = flat[..end.0].trim();
        if !head.is_empty() {
            return head.to_string();
        }
    }
    if flat.chars().count() <= TITLE_MAX {
        return flat;
    }
    // Cut at a word boundary within budget; fall back to the hard cut for a single long token.
    let cut: usize = flat.char_indices().nth(TITLE_MAX).map(|(i, _)| i).unwrap_or(flat.len());
    let head = &flat[..cut];
    match head.rfind(' ') {
        Some(sp) if sp > 0 => format!("{}…", &head[..sp]),
        _ => format!("{head}…"),
    }
}

/// The write shape for a new request (`surface` empty falls back to {@link DEFAULT_SURFACE}).
#[derive(Debug, Clone, Default)]
pub struct NewRequest {
    pub text: String,
    pub surface: String,
    pub cmd: Option<String>,
    pub shot_path: Option<String>,
    pub ts: i64,
    /// The filing session's pane id (#debug-request-carries-its-origin). The CLI stamps it from
    /// `$BSC_AUDIT_PANE`; `None` records NULL rather than guessing.
    pub origin: Option<String>,
    /// An explicit short title. `None` stores NULL and readers derive one from `text`
    /// ([`Request::display_title`]) — the derivation is deliberately NOT frozen into the row, so
    /// improving it improves every existing request.
    pub title: Option<String>,
    /// The filing context (`a-request-records-where-it-actually-came-from`) — who/where/which build.
    /// `Default` is every field absent, which is what a caller with nothing to say should store.
    pub context: FilingContext,
}

/// WHO, WHERE and WHICH BUILD, as `bsc request new` observed them at filing time.
///
/// Every field is `Option` and every `None` is written as SQL NULL. Nothing in the store or the CLI
/// substitutes a default for one of these: a fabricated cwd or an invented repo is indistinguishable
/// from a measured one to every later reader, and that is the failure this record exists to prevent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FilingContext {
    /// The filing session's pane id, stamped from `$BSC_AUDIT_PANE`.
    pub origin_pane: Option<String>,
    /// The free-text actor `--from` named.
    pub origin_actor: Option<String>,
    pub cwd: Option<String>,
    pub repo: Option<String>,
    pub worktree: Option<String>,
    pub branch: Option<String>,
    pub bsc_version: Option<String>,
    pub bsc_built_at: Option<i64>,
    pub harness: Option<String>,
    pub model: Option<String>,
    pub session_id: Option<String>,
}

/// Filters for [`Store::list`]. All-default lists every request, newest first.
#[derive(Debug, Clone, Default)]
pub struct Filter {
    /// Only requests the debug session hasn't resolved yet (the work queue).
    pub open_only: bool,
    pub surface: Option<String>,
    pub limit: Option<i64>,
}

/// The request store — a thin owner of the SQLite connection plus the file/read/resolve ops.
pub struct Store {
    conn: Connection,
}

impl Store {
    /// Open (creating + migrating) the requests.db at `path`. WAL + busy_timeout so the app and the CLI
    /// share the db without a SQLITE_BUSY race.
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        Ok(Store { conn: bsc_sqlite_util::open_migrated(path, schema::migrate)? })
    }

    /// An ephemeral in-memory store — for tests.
    pub fn open_in_memory() -> rusqlite::Result<Store> {
        Ok(Store { conn: bsc_sqlite_util::open_in_memory_migrated(schema::migrate)? })
    }

    /// Empty the whole store — see [`bsc_sqlite_util::clear_tables`] for why it truncates.
    /// Are debug sessions ALLOWED AT ALL on this machine? The global off switch.
    ///
    /// DISTINCT FROM `paused`, and the difference is the whole reason both exist:
    ///
    ///  - `paused` is a STATE — "not right now" — expected to be temporary, and `resume` undoes it.
    ///  - this is a POLICY — "this machine does not run debug sessions" — and nothing about the queue
    ///    changes it. A resume cannot override it, which is the point: `resume` is reached for
    ///    routinely, and a policy that a routine command can silently lift is not a policy.
    ///
    /// Defaults to ENABLED, because that is the behaviour every existing install already has and a
    /// default that changes underneath someone is its own bug. An operator turns it off deliberately.
    pub fn sessions_enabled(&self) -> rusqlite::Result<bool> {
        let v: Option<String> = self
            .conn
            .query_row("SELECT value FROM request_settings WHERE key = 'sessions_enabled'", [], |r| r.get(0))
            .optional()?;
        // Only an explicit "0" disables. An unreadable or absent row reads as ENABLED, matching the
        // install that never set it — the same fail-safe direction `is_paused` uses, for the same
        // reason: a missing row must not silently change what the app does.
        Ok(v.as_deref() != Some("0"))
    }

    /// Turn debug sessions on or off globally. Returns the value actually stored, so a caller reports
    /// what IS rather than what it asked for.
    pub fn set_sessions_enabled(&self, enabled: bool) -> rusqlite::Result<bool> {
        self.conn.execute(
            "INSERT INTO request_settings (key, value) VALUES ('sessions_enabled', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [if enabled { "1" } else { "0" }],
        )?;
        self.sessions_enabled()
    }

    /// Is auto-spawn PAUSED for this queue?
    ///
    /// Fail-safe direction, and it is the opposite of the usual one: an unreadable or missing setting
    /// reads as NOT paused, because the safe default here is the behaviour the app already has. A
    /// missing row must not silently stop the debug fleet — a pause is something a person asked for,
    /// so it has to be recorded to be true.
    pub fn is_paused(&self) -> rusqlite::Result<bool> {
        let v: Option<String> = self
            .conn
            .query_row("SELECT value FROM request_settings WHERE key = 'paused'", [], |r| r.get(0))
            .optional()?;
        Ok(v.as_deref() == Some("1"))
    }

    /// Pause or resume auto-spawn. Returns the value actually stored, so a caller reports what IS
    /// rather than what it asked for.
    pub fn set_paused(&self, paused: bool) -> rusqlite::Result<bool> {
        self.conn.execute(
            "INSERT INTO request_settings (key, value) VALUES ('paused', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [if paused { "1" } else { "0" }],
        )?;
        self.is_paused()
    }

    pub fn clear(&self) -> rusqlite::Result<()> {
        bsc_sqlite_util::clear_tables(&self.conn, schema::ALL_TABLES)
    }

    /// File a request; returns it with its assigned id. A blank `surface` falls back to the default.
    pub fn create(&self, n: &NewRequest) -> rusqlite::Result<Request> {
        let surface = if n.surface.trim().is_empty() { DEFAULT_SURFACE } else { n.surface.as_str() };
        // Blank strings normalize to NULL: a `--from ""` or `--title ""` is an ABSENT value, and storing
        // the empty string instead would make `display_title` and the graph's origin lookup treat "we were
        // told nothing" as "we were told it is empty".
        let blank_to_none = |s: &Option<String>| s.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
        let c = &n.context;
        self.conn.execute(
            "INSERT INTO requests (text, surface, cmd, shot_path, status, created_at, origin, title,
                                   origin_pane, origin_actor, cwd, repo, worktree, branch,
                                   bsc_version, bsc_built_at, harness, model, session_id)
             VALUES (?1, ?2, ?3, ?4, 'open', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![
                n.text,
                surface,
                n.cmd,
                n.shot_path,
                n.ts,
                blank_to_none(&n.origin),
                blank_to_none(&n.title),
                // The context is normalized through the SAME blank→NULL rule: a caller that hands over
                // an empty cwd is saying "I could not read one", and storing "" would make that absence
                // sort, filter and render as a value.
                blank_to_none(&c.origin_pane),
                blank_to_none(&c.origin_actor),
                blank_to_none(&c.cwd),
                blank_to_none(&c.repo),
                blank_to_none(&c.worktree),
                blank_to_none(&c.branch),
                blank_to_none(&c.bsc_version),
                c.bsc_built_at,
                blank_to_none(&c.harness),
                blank_to_none(&c.model),
                blank_to_none(&c.session_id),
            ],
        )?;
        let id = self.conn.last_insert_rowid();
        Ok(self.get(id)?.expect("request exists after insert"))
    }

    /// One request by id, or `None`.
    pub fn get(&self, id: i64) -> rusqlite::Result<Option<Request>> {
        self.conn
            .query_row(&format!("SELECT {COLS} FROM requests WHERE id = ?1"), params![id], row_to_request)
            .optional()
    }

    /// The request queue under `filter`, newest first.
    pub fn list(&self, filter: &Filter) -> rusqlite::Result<Vec<Request>> {
        let mut sql = format!("SELECT {COLS} FROM requests");
        let mut clauses: Vec<String> = Vec::new();
        let mut vals: Vec<rusqlite::types::Value> = Vec::new();
        if filter.open_only {
            clauses.push("status = 'open'".into());
        }
        if let Some(s) = &filter.surface {
            vals.push(rusqlite::types::Value::Text(s.clone()));
            clauses.push(format!("surface = ?{}", vals.len()));
        }
        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }
        sql.push_str(" ORDER BY id DESC");
        if let Some(n) = filter.limit {
            sql.push_str(&format!(" LIMIT {}", n.max(0)));
        }
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(vals), row_to_request)?;
        rows.collect()
    }

    /// Mark a request resolved — stamps `note` + `resolved_at`. Accepts an `open` OR a `claimed` request
    /// (#3535: a session resolves the one it claimed), so it is not a no-op for the normal path. Returns
    /// whether an unresolved request matched, so resolving an unknown / already-resolved id is reported.
    pub fn resolve(&self, id: i64, note: Option<&str>, ts: i64) -> rusqlite::Result<bool> {
        let n = self.conn.execute(
            "UPDATE requests SET status = 'resolved', note = ?2, resolved_at = ?3 \
             WHERE id = ?1 AND status IN ('open', 'claimed')",
            params![id, note, ts],
        )?;
        Ok(n > 0)
    }

    /// Atomically CLAIM the oldest open request (#3535): `open` → `claimed`, stamping `by` (the holder's
    /// pane id) + `ts`. Returns the claimed request, or `None` when nothing is claimable. Race-free across
    /// processes: the whole thing is ONE statement whose `WHERE` re-selects the oldest `open` row under
    /// SQLite's write lock, so two concurrent claimers (the standing session + an overflow one) can never
    /// take the same request — the second re-evaluates the subquery after the first commits and gets the
    /// next row (or none).
    pub fn claim(&self, by: Option<&str>, ts: i64) -> rusqlite::Result<Option<Request>> {
        self.conn
            .query_row(
                &format!(
                    "UPDATE requests SET status = 'claimed', claimed_by = ?1, claimed_at = ?2 \
                     WHERE id = (SELECT id FROM requests WHERE status = 'open' ORDER BY id ASC LIMIT 1) \
                     RETURNING {COLS}"
                ),
                params![by, ts],
                row_to_request,
            )
            .optional()
    }

    /// Return a CLAIMED request to the open queue (`claimed` → `open`, clearing who/when) — so a session
    /// that abandoned or crashed doesn't strand its request as permanently in-flight. Returns whether a
    /// claimed request matched.
    pub fn unclaim(&self, id: i64) -> rusqlite::Result<bool> {
        let n = self.conn.execute(
            "UPDATE requests SET status = 'open', claimed_by = NULL, claimed_at = NULL \
             WHERE id = ?1 AND status = 'claimed'",
            params![id],
        )?;
        Ok(n > 0)
    }

    /// Delete every RESOLVED request; returns how many rows were removed (#3522). The store only ever grew
    /// before this — `resolve` flips the status but the row stayed, so completed work accumulated forever.
    /// Keys off `status`, NOT a timestamp, because legacy rows resolved before #3295 stamped `resolved_at`
    /// carry a null one; an OPEN request (even a corrupted one) is never touched.
    pub fn prune_resolved(&self, with_answers: bool) -> rusqlite::Result<usize> {
        if with_answers {
            return self.conn.execute("DELETE FROM requests WHERE status = 'resolved'", []);
        }
        self.conn.execute(
            "DELETE FROM requests WHERE status = 'resolved' \
             AND id NOT IN (SELECT DISTINCT request_id FROM request_notes)",
            [],
        )
    }

    /// Resolved requests split by whether they carry an ANSWER — `(prunable, answered)` counts. What
    /// `prune` reports before it deletes anything, and what `--dry-run` prints instead of deleting.
    pub fn prune_preview(&self) -> rusqlite::Result<(usize, usize)> {
        let answered: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM requests WHERE status = 'resolved' \
             AND id IN (SELECT DISTINCT request_id FROM request_notes)",
            [],
            |r| r.get(0),
        )?;
        let total: i64 =
            self.conn.query_row("SELECT COUNT(*) FROM requests WHERE status = 'resolved'", [], |r| r.get(0))?;
        Ok(((total - answered) as usize, answered as usize))
    }

    /// Delete ONE request by id, regardless of status; returns whether a row matched (#3522). The escape
    /// hatch `prune_resolved` can't reach: a request that will never be legitimately resolved — e.g. one
    /// whose text was corrupted at filing time — is still `open`, so only an explicit removal clears it.
    pub fn remove(&self, id: i64) -> rusqlite::Result<bool> {
        let n = self.conn.execute("DELETE FROM requests WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    /// Append a note to a request's thread (#bsc-request-gains-a-note-verb) — a reply that does NOT
    /// close it.
    ///
    /// The status is deliberately untouched. Before this, the only way to answer a request was
    /// `resolve`, which asserts it is fixed: request #50 was resolved, the designer measured the
    /// behaviour as unchanged, and burned three probes filing #52 to ask what "resolved" had meant. A
    /// channel that can only be answered by closing it will keep producing that.
    ///
    /// APPEND-ONLY by construction — there is no update or delete path to a note, which is the same
    /// guarantee `bsc plan change note` makes and for the same reason: a thread whose earlier entries can
    /// be rewritten is not a record of what was said.
    ///
    /// Append-only is not FOREVER, and the difference cost a thread. `request_notes` cascades on the
    /// request, so `remove` and `prune` take the whole discussion with it. On 2026-08-24 request #99 was
    /// answered with four notes — root cause, diagnosis, cross-link, outcome — resolved, and pruned
    /// within the hour by a routine tidy-up; nothing records that it was ever filed. So [`prune_resolved`]
    /// now keeps an ANSWERED thread unless asked twice, because the answer is the durable half: the
    /// reasoning for why a reported behaviour was or was not a bug lives nowhere else.
    ///
    /// `Ok(false)` when no such request exists, so the caller can REFUSE rather than accept a reply that
    /// goes nowhere.
    pub fn add_note(&self, id: i64, body: &str, author: Option<&str>, ts: i64) -> rusqlite::Result<bool> {
        // Existence is checked rather than left to the foreign key: a FK violation is an opaque error,
        // and this needs to tell the caller "no request 61" in a form it can turn into a message.
        if self.get(id)?.is_none() {
            return Ok(false);
        }
        self.conn.execute(
            "INSERT INTO request_notes (request_id, body, author, at) VALUES (?1, ?2, ?3, ?4)",
            params![id, body, author, ts],
        )?;
        Ok(true)
    }

    /// A request's notes, oldest first — the thread in the order it was written.
    pub fn notes(&self, id: i64) -> rusqlite::Result<Vec<RequestNote>> {
        self.conn
            .prepare("SELECT id, request_id, body, author, at FROM request_notes WHERE request_id = ?1 ORDER BY id ASC")?
            .query_map(params![id], |r| {
                Ok(RequestNote {
                    id: r.get(0)?,
                    request_id: r.get(1)?,
                    body: r.get(2)?,
                    author: r.get(3)?,
                    at: r.get(4)?,
                })
            })?
            .collect()
    }
}

/// One reply on a request's thread (#bsc-request-gains-a-note-verb).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RequestNote {
    pub id: i64,
    pub request_id: i64,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub at: i64,
}

/// The column list `row_to_request` decodes, in one place so the SELECTs can't drift from the mapper.
const COLS: &str = "id, text, surface, cmd, shot_path, status, note, created_at, resolved_at, claimed_by, \
     claimed_at, origin, title, origin_pane, origin_actor, cwd, repo, worktree, branch, bsc_version, \
     bsc_built_at, harness, model, session_id";

fn row_to_request(r: &rusqlite::Row) -> rusqlite::Result<Request> {
    // Read once, then move into the struct — `display_title` needs both before either is placed.
    let text: String = r.get(1)?;
    let title: Option<String> = r.get(12)?;
    // Read before the move, for the same reason `title` is: `origin_kind` is derived from all three.
    let origin: Option<String> = r.get(11)?;
    let origin_pane: Option<String> = r.get(13)?;
    let origin_actor: Option<String> = r.get(14)?;
    Ok(Request {
        id: r.get(0)?,
        surface: r.get(2)?,
        cmd: r.get(3)?,
        shot_path: r.get(4)?,
        status: r.get(5)?,
        note: r.get(6)?,
        created_at: r.get(7)?,
        resolved_at: r.get(8)?,
        claimed_by: r.get(9)?,
        claimed_at: r.get(10)?,
        // Derived HERE, from which columns are populated — never from the string's shape. This is the
        // single place the pane/actor question is answered, so no reader re-answers it differently.
        origin_kind: OriginKind::of(origin_pane.as_deref(), origin_actor.as_deref(), origin.as_deref()),
        origin,
        origin_pane,
        origin_actor,
        cwd: r.get(15)?,
        repo: r.get(16)?,
        worktree: r.get(17)?,
        branch: r.get(18)?,
        bsc_version: r.get(19)?,
        bsc_built_at: r.get(20)?,
        harness: r.get(21)?,
        model: r.get(22)?,
        session_id: r.get(23)?,
        title: title.clone(),
        // Derived HERE so every reader — CLI, app, graph — sees one label and none of them has to know
        // the fallback rule.
        display_title: match title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            Some(t) => t.to_string(),
            None => derive_title(&text),
        },
        text,
    })
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/provenance.rs, src/schema.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-request--<module>.rs
//     bsc graph impl set --id bsc-request--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-request--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-request--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));
