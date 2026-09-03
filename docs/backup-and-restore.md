# Backup and restore

> **This is the disaster runbook.** It assumes the machine is gone and you have the NAS. If you are
> reading it for that reason, start at [Restore](#restore).

Two things need backing up, and they fail differently:

| | where it lives | what loses it |
|---|---|---|
| **The stores** — libraries, personas, components, and every per-project `plan.db` | `~/.base-studio-code/` | a disk failure; nothing else keeps a copy |
| **The git environment** — 125 branches, 32 stashes, uncommitted worktree state | the repo and its ~38 worktrees | the same disk, and **nothing is pushed to a remote by policy** |

The second is the larger exposure precisely *because* this project is local-first. There is no
`origin` on GitHub holding a spare copy of anything.

## Back up

### The stores

```bash
bsc studio save "full-system" --all --out /path/to/dest
```

`--dir` says which install to **read**; `--out` says where the backup **goes**. Conflating those two
is the mistake the flag exists to prevent — `--dir <empty>` used to create empty stores at the
destination and back *those* up, reporting success.

What you get is a directory: `studio.json` (the library bundle), `stores/*.db`, `plans/*.db`, and
`manifest.json` recording every capture with its integrity result.

**Everything is captured by discovery, not from a list.** Every `*.db` under the base dir is taken,
so a store added by a future release is backed up without anyone remembering to add it. The only
exception is `secrets.db`, which is never captured by any flag — see [What is deliberately not backed
up](#what-is-deliberately-not-backed-up).

Two refusals you may hit, both deliberate:

- **An all-empty source is refused**, naming what it found bare. A backup that appears to succeed and
  contains nothing is the worst outcome this verb has. `--allow-empty` overrides it; `--dir` pointing
  somewhere unexpected is the usual real cause.
- **`--out` at a `.json` path is refused** when a database-backed system is selected, because 28 MB
  of SQLite cannot live in a JSON bundle. The message names what forced the directory.

Without any scope flags you get the shareable **library** bundle, unchanged from what `save` always
produced. `bsc studio save help` lists the per-system flags, generated from the roster.

### The git environment

A `git clone --mirror` is **not** sufficient, and the reason is the trap worth knowing:

> A mirror copies `refs/stash` — the **top** stash entry — but not that ref's reflog, where every
> other entry lives. Measured here: **32 stashes, of which a mirror preserved one.** The stash is
> also repo-global and shared across every worktree, so those entries are real rescued work.

So the git backup is three things:

```bash
# 1. a mirror, plus each stash fetched in as a REAL ref so its objects travel
git clone --mirror <repo> backup/base-studio-code.git
git -C <repo> stash list --format='%gd|%H' | while IFS='|' read -r ref sha; do
  git -C backup/base-studio-code.git fetch <repo> "$sha:refs/stash-backup/${ref//[!0-9]/}"
done

# 2. a single-file bundle carrying ALL of it, which is what travels
git -C backup/base-studio-code.git bundle create base-studio-code.bundle --all

# 3. uncommitted worktree state, which NO ref-based backup can see
git -C <worktree> diff HEAD > <name>.tracked.patch
git -C <worktree> ls-files --others --exclude-standard -z | tar --null -T - -czf <name>.untracked.tar.gz -C <worktree>
```

Step 3 matters more than it looks: `git diff` cannot see an untracked file at all, so a new module
that has never been `git add`ed is invisible to every other line above.

### Where it goes

```
lumpy-space-princess@10.99.6.10:/srv/nas/storage/backups/base-studio-code/<YYYY-MM-DD>/
    base-studio-code.bundle    # git: all refs, all history, all stashes
    bsc-stores.tar.gz          # stores/ + plans/
    stashes.tar.gz             # each stash also as a readable patch
    worktrees.tar.gz           # uncommitted diffs + the worktree->branch map
    SHA256SUMS
```

**`/srv/nas/storage` is the right path and the others are not.** It is a separate physical disk
(`nvme1n1p1`); `/srv/nas/archive` and `/srv/nas/drop` sit on the NAS's root filesystem. There is no
RAID and no ZFS on that box, so the NAS is a second *machine*, not redundant storage — a disk failure
there still loses the copy.

Transport is `scp`/`ssh`/`tar`. `rsync` is not installed locally (`deinstall ok config-files`), and
neither is `sshfs`; installing either needs a sudo password.

## Verify

**Verify on the far end, never locally.** A local check proves the bytes you made, not the bytes that
arrived.

```bash
ssh lumpy-space-princess@10.99.6.10 "cd <dest> && sha256sum -c SHA256SUMS"
```

Then prove it restores, on the NAS:

```bash
ssh lumpy-space-princess@10.99.6.10 '
  T=$(mktemp -d)
  git clone -q <dest>/base-studio-code.bundle "$T/r" && cd "$T/r"
  git rev-list --count origin/main          # expect the full history
  git branch -r | wc -l; git tag | wc -l
  git fetch -q origin "refs/stash-backup/*:refs/stash-backup/*"
  git for-each-ref refs/stash-backup | wc -l
'
```

A backup nobody has restored is a hope, not a backup.

## Restore

> `bsc studio restore` does not exist yet — see `the-backup-proves-it-can-be-restored`. Until it
> does, restoring is the manual sequence below, which is exactly what that verb will automate.

```bash
# 1. the git environment
git clone base-studio-code.bundle base-studio-code
cd base-studio-code
git fetch origin 'refs/heads/*:refs/heads/*' 'refs/stash-backup/*:refs/stash-backup/*'

# a stash comes back as an ordinary commit; apply the one you want
git stash apply <sha-from-refs/stash-backup>

# 2. the stores — into a base dir, NOT over a live one
tar xzf bsc-stores.tar.gz -C /tmp/restore
cp /tmp/restore/stores-and-plans/stores/*.db ~/.base-studio-code/
cp /tmp/restore/stores-and-plans/plans/*.db  ~/.base-studio-code/plans/

# 3. confirm it is really there
sqlite3 ~/.base-studio-code/plans/studio-code.db 'PRAGMA integrity_check; select count(*) from issues'
```

**Do not copy stores over a running app.** Every `.db` is captured with `VACUUM INTO`, so each file
in the backup is a consistent point-in-time image with no `-wal` sidecar. Dropping one beside a live
`-wal` from a different generation is how a restore corrupts the thing it is restoring.

## Resolving a commit after the history wipe

The working repo's history was truncated deliberately. **799 of the 1,039 change records in
`plan.db` carry a `merge_sha` that no longer resolves in the live repo.** The commits still exist —
in the pre-wipe archive bundle, kept locally and on the NAS.

```bash
git -C <repo> fetch <archive>.bundle 'refs/heads/*:refs/archive/*'
git -C <repo> show <old-merge-sha>
```

The audit trail itself never depended on git: `bsc plan change render <ref>` carries the gate
evidence, the reviewer verdict and the notes, and none of that lives in a commit.

## What is deliberately not backed up

`secrets.db` is captured by **nothing** — not `--all`, not a scope, not by naming it. This is
recorded rather than silent, and the reasoning is:

- The values live in the OS keychain, so the file holds pairing *metadata*, not credentials. But
  **which services you are paired with is itself disclosure**, and a backup is the artifact most
  likely to travel.
- **A restore on another machine would be incoherent.** The rows point at keychain entries that will
  not exist there, so restoring them describes pairings the machine does not have — worse than having
  none, because the app would believe it is paired.

Losing it costs you re-pairing, not a credential. Whether it should become backupable (and under what
encryption) is `the-credential-store-needs-its-own-backup-decision`.

## Known gaps

These are filed, not forgotten:

| gap | item |
|---|---|
| No `restore` or `verify` verb — the sequence above is manual | `the-backup-proves-it-can-be-restored` |
| Nothing schedules a backup or prunes old ones; the previous NAS backup was 12 days stale when found | `a-backup-rotates-and-runs-without-being-remembered` |
| The backup is unencrypted, and plan stores hold discovery, decisions and change history | `a-backup-is-encrypted-at-rest` |
| The git half is a hand-run sequence, not a `bsc` verb | `the-backup-covers-the-git-environment` |
