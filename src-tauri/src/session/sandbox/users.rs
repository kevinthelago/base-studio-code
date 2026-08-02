//! Per-agent filesystem isolation via Linux users inside the sealed sandbox distro (#1994).
//!
//! Builds on the shared-distro sandbox (#1988): one sealed `bsc-agent-sandbox` distro protects the
//! Windows host + secrets. This adds defense-in-depth *between* co-located agents — each worker /
//! director runs as its **own** non-root Linux user with a locked-down (`700`) home, so Worker A
//! literally cannot read Worker B's files (Unix perms deny it) even via raw Bash, without N separate
//! rootfs. Chosen over one-distro-per-agent per the issue's cost/benefit table.
//!
//! Two shared things survive isolation (the issue's "real cost"), and #4260 settles the boundary the
//! original landing deferred — **what is private is the code an agent edits; what is shared is
//! everything agents must agree on**:
//!  1. **Coordination + app state** ([`SHARED_BASE`], the one `~/.base-studio-code` every agent user
//!     symlinks to) — `coord.log`, the project hub, `plan.db`, and the global `bsc` stores, inside a
//!     **group-shared** setgid dir ([`SHARED_DIR`], mode `2770`, owned by [`AGENT_GROUP`]). Every
//!     agent user joins that group, so all can read the stores and append coord events.
//!  2. **The git object store** — ONE clone per repo under [`SHARED_BASE`] (`core.sharedRepository=group`),
//!     with each agent's **worktree** created by that agent inside its own `700` home
//!     ([`agent_worktrees_dir`]). N agents therefore cost one fetch, and still cannot read each
//!     other's checkout.
//!
//! **Why the worktree location is load-bearing (#4260).** Before this, every hub, clone and worktree
//! lived under `/home/agent` — which is mode `700` and owned by the distro's default user — while the
//! session ran as `bsc-<slug>-<hash>`. A worker could not `cd` into its OWN worktree (verified on a
//! live distro: `Permission denied`), so per-agent users could never actually be switched on. Putting
//! each worktree in its owner's home is what makes the isolation real rather than nominal.
//!
//! Everything here is **pure** except [`ensure_sandbox_user`] (the one `wsl.exe`-touching command),
//! so the naming / home / provisioning-script / spawn-arg logic unit-tests without a live distro.

use super::{require_windows, wsl_exec, AGENT_SANDBOX_DISTRO};

/// Conservative cap on a Linux username length. `useradd` rejects longer names on most systems
/// (the traditional `UT_NAMESIZE`/`utmp` limit is 32; we stay one under to be safe).
const MAX_USERNAME_LEN: usize = 31;

/// Prefix on every per-agent user, so provisioned users are recognizable + reapable and never
/// collide with the distro's baked-in `agent` / `root`.
pub(crate) const AGENT_USER_PREFIX: &str = "bsc-";

/// The shared Unix group every per-agent user joins, owning the coordination dir so all agents can
/// read/append shared state while their private homes stay `700`.
pub(crate) const AGENT_GROUP: &str = "bsc-agents";

/// The group-shared, setgid coordination directory (`coord.log`, shared `plan.db`, …). Outside every
/// agent's `700` home so shared state survives per-user isolation; `2770` + [`AGENT_GROUP`] ownership
/// means new files inherit the group and stay unreadable to users outside it.
pub(crate) const SHARED_DIR: &str = "/srv/bsc-shared";

/// The ONE `~/.base-studio-code` every agent user resolves to — every per-agent home symlinks
/// `.base-studio-code` here (#4260), so `bsc`'s home-derived paths (the global skills / components /
/// algorithms stores, `coord.log`, the project hub + `plan.db`) are common ground across isolated
/// agents. Without this, isolating agents by Linux user would silently give each one an EMPTY set of
/// stores — and the worker protocol's "read from the store, not from a copy" (#4191) would break.
pub(crate) const SHARED_BASE: &str = "/srv/bsc-shared/base";

/// The private worktree root inside a per-agent user's `700` home — where that agent's checkouts live,
/// unreadable to every other agent (#1994/#4260). Deliberately NOT under the shared base: the code an
/// agent edits is exactly the thing isolation is for.
pub(crate) fn agent_worktrees_dir(user: &str) -> String {
    format!("{}/worktrees", agent_home(user))
}

/// FNV-1a (64-bit) hash of `s`. Hand-rolled because `std`'s `DefaultHasher` is explicitly NOT stable
/// across releases — we need a hash that yields the SAME username for a given identity on every run
/// (idempotent provisioning + session reuse depend on it).
fn fnv1a(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// The private home of a per-agent user: `/home/<user>`, locked to mode `700` by provisioning.
pub(crate) fn agent_home(user: &str) -> String {
    format!("/home/{user}")
}

/// Derive a deterministic, valid Linux username from a session/pane `identity` (e.g. `proj:api-stream`,
/// `proj:own/web:triage`, `planning_proj`).
///
/// - **Deterministic:** same identity → same user, so provisioning is idempotent and a relaunched
///   agent reuses its home + files.
/// - **Collision-resistant:** distinct identities → distinct users. A truncated human slug alone could
///   collide, so an 8-hex FNV-1a suffix of the FULL identity disambiguates.
/// - **Valid:** lowercased and reduced to `[a-z0-9-]`, first char forced to a letter (never `-`/digit),
///   `≤ MAX_USERNAME_LEN`. Shape: `bsc-<slug>-<hash8>`.
pub(crate) fn agent_user_name(identity: &str) -> String {
    let hash8 = format!("{:08x}", fnv1a(identity) & 0xffff_ffff);
    // Sanitize the identity into a readable slug: lowercase, keep [a-z0-9], every run of anything
    // else collapses to a single '-'. Debug-friendly ("proj:api" → "proj-api") without affecting the
    // hash suffix that guarantees uniqueness.
    let mut slug = String::new();
    let mut last_dash = false;
    for c in identity.chars() {
        let lc = c.to_ascii_lowercase();
        if lc.is_ascii_lowercase() || lc.is_ascii_digit() {
            slug.push(lc);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    let slug = slug.trim_matches('-');

    // Budget: prefix + slug + '-' + 8-hex hash ≤ MAX. Truncate the SLUG (never the hash) to fit.
    let fixed = AGENT_USER_PREFIX.len() + 1 + hash8.len(); // "bsc-" + "-" + hash
    let slug_budget = MAX_USERNAME_LEN.saturating_sub(fixed);
    let slug: String = slug.chars().take(slug_budget).collect();
    let slug = slug.trim_end_matches('-'); // don't leave a trailing '-' from truncation

    if slug.is_empty() {
        format!("{AGENT_USER_PREFIX}{hash8}")
    } else {
        format!("{AGENT_USER_PREFIX}{slug}-{hash8}")
    }
}

/// The idempotent provisioning script, run as **root** inside the distro (the default user is the
/// non-root `agent`, and `useradd` needs root — hence [`ensure_sandbox_user`] passes `-u root`).
///
/// Creates, if absent: the shared [`AGENT_GROUP`]; the per-agent user with a home + `/bin/bash` shell,
/// joined to that group; the group-shared setgid [`SHARED_DIR`] + [`SHARED_BASE`]; the agent's private
/// [`agent_worktrees_dir`]; and the `~/.base-studio-code` → [`SHARED_BASE`] symlink that gives it the
/// shared stores. Then (always, idempotently) re-asserts group membership and `chmod 700` on the
/// private home. Safe to run repeatedly.
///
/// The symlink is created ONLY when nothing is there (`[ -e ]`), so a distro that still holds a real
/// `~/.base-studio-code` directory is never clobbered — the migration is a rootfs rebuild, not a
/// silent delete of an existing store.
///
/// `user` is assumed already validated to `[a-z0-9-]` by [`agent_user_name`]; it is still embedded via
/// a shell variable (not interpolated into a command word) so the script is robust regardless.
pub(crate) fn provision_user_script(user: &str) -> String {
    format!(
        "set -e\n\
         u={user}\n\
         grp={grp}\n\
         shared={shared}\n\
         base={base}\n\
         getent group \"$grp\" >/dev/null 2>&1 || groupadd \"$grp\"\n\
         id -u \"$u\" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash -g \"$grp\" \"$u\"\n\
         usermod -aG \"$grp\" \"$u\"\n\
         chmod 700 \"/home/$u\"\n\
         mkdir -p \"$shared\" \"$base\"\n\
         chgrp \"$grp\" \"$shared\" \"$base\"\n\
         chmod 2770 \"$shared\" \"$base\"\n\
         mkdir -p \"/home/$u/worktrees\"\n\
         chown \"$u\":\"$grp\" \"/home/$u/worktrees\"\n\
         [ -e \"/home/$u/.base-studio-code\" ] || ln -s \"$base\" \"/home/$u/.base-studio-code\"\n\
         chown -h \"$u\":\"$grp\" \"/home/$u/.base-studio-code\"\n",
        user = user,
        grp = AGENT_GROUP,
        shared = SHARED_DIR,
        base = SHARED_BASE,
    )
}

/// Provision (idempotently) the per-agent Linux user for `identity` inside the sealed distro (#1994)
/// and return its derived username — the value a caller threads to `pty_create`'s `wsl_user` so the
/// session runs as that user, isolated in its `700` home.
///
/// Runs the [`provision_user_script`] as **root** (`wsl -u root`) since the default `agent` user can't
/// `useradd`. Idempotent: a second call for the same identity is a no-op (the `id -u` / `getent`
/// guards) and returns the same name. Windows-only (the WSL2 cage is Windows-only).
#[tauri::command]
pub(crate) fn ensure_sandbox_user(identity: String) -> Result<String, String> {
    require_windows()?;
    let user = agent_user_name(&identity);
    let script = provision_user_script(&user);
    // Root is required for useradd/groupadd; `-u root` overrides the distro's non-root default user.
    wsl_exec(&["-d", AGENT_SANDBOX_DISTRO, "-u", "root", "--", "sh", "-c", script.as_str()])?;
    Ok(user)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_valid_linux_username(name: &str) -> bool {
        !name.is_empty()
            && name.len() <= MAX_USERNAME_LEN
            && name.chars().next().is_some_and(|c| c.is_ascii_lowercase())
            && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    }

    #[test]
    fn user_name_is_deterministic() {
        // Same identity → same user (idempotent provisioning + relaunch reuse depend on this).
        assert_eq!(agent_user_name("proj:api-stream"), agent_user_name("proj:api-stream"));
        assert_eq!(agent_user_name("planning_proj"), agent_user_name("planning_proj"));
    }

    #[test]
    fn distinct_identities_get_distinct_users() {
        let a = agent_user_name("proj:api-stream");
        let b = agent_user_name("proj:auth-ui");
        let c = agent_user_name("proj:director");
        let d = agent_user_name("other:api-stream");
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d, "same stream, different project ⇒ different user");
        assert_ne!(b, c);
    }

    #[test]
    fn user_names_are_valid_linux_usernames() {
        for id in [
            "proj:api-stream",
            "proj:own/web:triage",
            "planning_proj",
            "proj:director",
            "UPPER:Mixed_Case/Weird!!chars",
            "p-1741-abc123:stream",
        ] {
            let name = agent_user_name(id);
            assert!(is_valid_linux_username(&name), "invalid username {name:?} from {id:?}");
            assert!(name.starts_with(AGENT_USER_PREFIX), "{name} missing prefix");
        }
    }

    #[test]
    fn long_identity_is_truncated_but_still_valid_and_unique() {
        let long = "proj:".to_string() + &"averylongstreamname".repeat(6); // ~120 chars
        let name = agent_user_name(&long);
        assert!(name.len() <= MAX_USERNAME_LEN, "len {} > {}", name.len(), MAX_USERNAME_LEN);
        assert!(is_valid_linux_username(&name));
        // The 8-hex hash of the FULL identity survives truncation, so two long identities that share a
        // truncated slug still differ.
        let long2 = long.clone() + "-different-tail";
        assert_ne!(agent_user_name(&long), agent_user_name(&long2));
        // No trailing '-' left dangling by truncation.
        assert!(!name.ends_with('-'));
    }

    #[test]
    fn slug_sanitization_collapses_separators() {
        // ':' '/' '_' and other non-alphanumerics collapse to single dashes; case is lowered.
        let name = agent_user_name("Proj:Api__Stream//x");
        assert!(name.starts_with("bsc-proj-api-stream-x-"), "unexpected slug in {name}");
        assert!(!name.contains("--"), "runs of separators must collapse: {name}");
    }

    #[test]
    fn empty_or_symbol_only_identity_still_yields_a_valid_user() {
        for id in ["", "::::", "!!!", "___"] {
            let name = agent_user_name(id);
            assert!(is_valid_linux_username(&name), "invalid {name:?} from {id:?}");
            // Falls back to just prefix + hash (no slug), still prefixed + valid.
            assert!(name.starts_with(AGENT_USER_PREFIX));
        }
    }

    #[test]
    fn home_is_under_slash_home() {
        assert_eq!(agent_home("bsc-api-1a2b3c4d"), "/home/bsc-api-1a2b3c4d");
    }

    #[test]
    fn worktrees_live_inside_the_agents_own_home() {
        // #4260: the regression that made per-agent users unusable was worktrees living under the
        // DEFAULT user's 700 home, where their owner couldn't even cd into them. They must be under
        // the agent's own home — and must NOT be under the group-shared base, which every agent reads.
        let dir = agent_worktrees_dir("bsc-api-1a2b3c4d");
        assert_eq!(dir, "/home/bsc-api-1a2b3c4d/worktrees");
        assert!(dir.starts_with(&agent_home("bsc-api-1a2b3c4d")));
        assert!(!dir.starts_with(SHARED_DIR), "a private worktree must not sit in the shared dir");
        assert!(!dir.starts_with("/home/agent/"), "a worktree under the default user's 700 home is unreachable by its owner");
    }

    #[test]
    fn provision_script_gives_the_agent_a_private_worktree_root_and_the_shared_stores() {
        let s = provision_user_script(&agent_user_name("proj:api-stream"));
        // The PRIVATE half: its own worktree root inside its own home, owned by it.
        assert!(s.contains("mkdir -p \"/home/$u/worktrees\""));
        assert!(s.contains("chown \"$u\":\"$grp\" \"/home/$u/worktrees\""));
        // The SHARED half: ~/.base-studio-code resolves to the one shared base, so an isolated agent
        // still reads the global bsc stores + coord.log (#4191) instead of an empty private set.
        assert!(s.contains("ln -s \"$base\" \"/home/$u/.base-studio-code\""));
        // Never clobber an existing real directory — migration is a rootfs rebuild, not a delete.
        assert!(s.contains("[ -e \"/home/$u/.base-studio-code\" ] ||"));
        // The symlink itself is chowned (-h) so the agent owns the link, not root.
        assert!(s.contains("chown -h \"$u\":\"$grp\" \"/home/$u/.base-studio-code\""));
    }

    #[test]
    fn provision_script_is_idempotent_and_locks_the_home() {
        let user = agent_user_name("proj:api-stream");
        let s = provision_user_script(&user);
        // useradd is guarded by an existence check ⇒ a re-run doesn't recreate the user.
        assert!(s.contains("id -u \"$u\" >/dev/null 2>&1 || useradd"));
        // groupadd is guarded by getent ⇒ idempotent.
        assert!(s.contains("getent group \"$grp\" >/dev/null 2>&1 || groupadd"));
        // The private home is locked to 700.
        assert!(s.contains("chmod 700 \"/home/$u\""));
        // Home is created with the user.
        assert!(s.contains("--create-home"));
        // The user is (re-)added to the shared group so coordination state stays reachable.
        assert!(s.contains("usermod -aG \"$grp\" \"$u\""));
        // The shared coord dir + shared base are setgid (2770) + group-owned.
        assert!(s.contains(&format!("shared={SHARED_DIR}")));
        assert!(s.contains(&format!("base={SHARED_BASE}")));
        assert!(s.contains("chmod 2770 \"$shared\" \"$base\""));
        assert!(s.contains("chgrp \"$grp\" \"$shared\" \"$base\""));
        // The derived (validated) user name is embedded.
        assert!(s.contains(&format!("u={user}")));
        // `set -e` so any provisioning step failing aborts the script.
        assert!(s.starts_with("set -e\n"));
    }

    #[test]
    fn fnv1a_is_stable_and_distinguishes() {
        // Pin a known vector so an accidental algorithm change is caught (stability is load-bearing).
        assert_eq!(fnv1a(""), 0xcbf2_9ce4_8422_2325);
        assert_ne!(fnv1a("a"), fnv1a("b"));
        assert_eq!(fnv1a("proj:api"), fnv1a("proj:api"));
    }
}
