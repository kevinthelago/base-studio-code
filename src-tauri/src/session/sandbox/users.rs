//! Per-agent filesystem isolation via Linux users inside the sealed sandbox distro (#1994).
//!
//! Builds on the shared-distro sandbox (#1988): one sealed `bsc-agent-sandbox` distro protects the
//! Windows host + secrets. This adds defense-in-depth *between* co-located agents — each worker /
//! director runs as its **own** non-root Linux user with a locked-down (`700`) home, so Worker A
//! literally cannot read Worker B's files (Unix perms deny it) even via raw Bash, without N separate
//! rootfs. Chosen over one-distro-per-agent per the issue's cost/benefit table.
//!
//! Two shared things survive isolation (the issue's "real cost"):
//!  1. **Coordination state** (`coord.log` / a shared `plan.db`) — lives in a **group-shared**,
//!     setgid dir ([`SHARED_DIR`], mode `2770`, owned by [`AGENT_GROUP`]); every agent user is added
//!     to that group so all can append coord events while their private homes stay `700`.
//!  2. **The git object store** — left to the existing worktree layout (a follow-on decides shared
//!     `.git` vs per-user clones; see the module doc's "needs a live distro" notes).
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
/// joined to that group; the group-shared setgid [`SHARED_DIR`]. Then (always, idempotently)
/// re-asserts group membership and `chmod 700` on the private home. Safe to run repeatedly.
///
/// `user` is assumed already validated to `[a-z0-9-]` by [`agent_user_name`]; it is still embedded via
/// a shell variable (not interpolated into a command word) so the script is robust regardless.
pub(crate) fn provision_user_script(user: &str) -> String {
    format!(
        "set -e\n\
         u={user}\n\
         grp={grp}\n\
         shared={shared}\n\
         getent group \"$grp\" >/dev/null 2>&1 || groupadd \"$grp\"\n\
         id -u \"$u\" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash -g \"$grp\" \"$u\"\n\
         usermod -aG \"$grp\" \"$u\"\n\
         chmod 700 \"/home/$u\"\n\
         mkdir -p \"$shared\"\n\
         chgrp \"$grp\" \"$shared\"\n\
         chmod 2770 \"$shared\"\n",
        user = user,
        grp = AGENT_GROUP,
        shared = SHARED_DIR,
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
        // The shared coord dir is setgid (2770) + group-owned.
        assert!(s.contains(&format!("shared={SHARED_DIR}")));
        assert!(s.contains("chmod 2770 \"$shared\""));
        assert!(s.contains("chgrp \"$grp\" \"$shared\""));
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
