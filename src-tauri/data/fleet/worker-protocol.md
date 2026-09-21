
## Fleet coordination protocol (auto-added — do not edit)

You are one of several parallel sessions building this project. Never stop to ask the user what to do with your work — not for direction, not for whether your work is done, and not for how to integrate it. **The default is LOCAL: nothing you do reaches a remote.** You gate, commit on your own branch, record what you did, mark your item complete, and move to the next one — you do not push, and you do not open a PR. Follow the push instruction in your kickoff; if it names a policy that DOES push (auto-pr, self-merge, push-confirm), that instruction wins over this paragraph and the PR rules further down apply.

**The stores are the source of truth — prefer them over anything quoted in your context.** Your context is assembled once, at launch; the stores are live. If a quote here disagrees with what a store returns, the store is right and the quote is stale. Read them directly rather than working from a copy.

- `bsc algorithms impl get <id>` · `bsc algorithms impl list [--tech t] [--domain d]` — the **algorithms library**. Anything your feature `requires` is named in the Reference implementations section below; read each one from here rather than re-deriving it.
- `bsc components get <id>` · `bsc components list [--kit k]` — the **component library**. Anything your feature `requires` may name a component as well as an algorithm, and the Reference implementations section below tells you which command reads each one. Search it before you build any UI too: the component you need usually exists, and when it does not, the library is still where the new one goes (see *NEW work is authored INTO the graph*, below).
- `bsc plan …` — this project's plan: issues, streams, features, contracts. Your scope section is a snapshot of it; `bsc plan` is the live copy.
- `bsc files read <path>` — a file's text, when you need a module no harvest lifts (a constants/types module).

**IF `bsc` IS NOT ON YOUR PATH, YOU ARE IN THE CAGE, and the same stores are mounted as read-only file trees.** That is by design, not a broken environment: the projection exists so a read surface can be given to you *without* binding a writable database into your namespace. Check once with `command -v bsc`; if it is absent, use these instead — they answer the same questions and need no `--help`:

<!-- caged-store-commands -->
```sh
ls /plan/items                 # every item; then cat /plan/items/<ref>/{status,title,body,acceptance}
ls /plan/by-status             # …grouped; ls /plan/by-status/open to see what is available
ls /graph/impl                 # the algorithms library; cat /graph/impl/<id>/code for an implementation
ls /ui/components              # the component library; cat /ui/components/<id>/{name,role,folder,kit}
```
<!-- /caged-store-commands -->

Two limits worth knowing before you hit them, because both look like breakage and are not:

- **`/ui` is the SUMMARY tier.** It tells you a component exists, its role, folder and kit — it does NOT carry the source. There is no caged equivalent of `bsc components get <id>`; if you need a component's source, ask the director with `bsc plan request new` rather than assuming it is missing.
- **Everything under `/plan`, `/graph`, `/ui` and `/coord` is read-only by the MOUNT**, so a write fails with `Read-only file system` no matter what your role allows. Your own worktree at `/repo` is writable, and so is any outbox the launch gave you (`/coord/out` to emit coordination, `/ui/out` to author a component, `/plan/out` to record what you did).

**A COMPONENT file is generated — edit its record, not the file (#4193).** Some source files are the emitted artifact of a component record: the graph holds the source of truth and the file is regenerated from it, so editing the file loses your change (the record keeps the old body, and the app renders the record).

- `bsc components backing <path>` — before you edit a `.tsx`, ask whether it has a record. Cheap, and it covers every component rather than a catalogue you would have to read by hand.
- If it is backed: `bsc components get <id>` to read it, `bsc components set …` to make the change, then `bsc components emit component <id> <dir>` so the file follows. Build and test against the emitted file — a record that cannot render fails there rather than in the app.
- `bsc components set` **merges** (#4197): send only the fields you are changing and the rest of the record is preserved. To REMOVE a field, say so — `--clear a,b` (or send the field as JSON `null`). Some pages have no source file at all, so the record is the only copy; a write that silently dropped what it did not restate would be unrecoverable.
- `bsc components backing gate $(git diff --name-only)` — run this before you commit. It exits non-zero and names the record if your change touched a backed file without going through it.

**An ALGORITHM is the same rule, reached a different way (#4254).** Anything your feature `requires` is a record the planner commissioned from the librarian — you pulled it in by **id**, so a change to it belongs on that record exactly as it does for a component:

- `bsc algorithms impl get <id>` to read it, `bsc algorithms impl set …` to change it, then re-emit so the file follows.
- `bsc algorithms impl set` **merges** (#4154): send only the fields you are changing. `--clear a,b` removes one explicitly. It is the same contract as `bsc components set`, so the two surfaces behave identically.
- There is **no `backing` gate** for algorithms, and it is not needed: an algorithm's file usually backs SEVERAL records (34 of 63 share a `src`), so a file→record lookup is ambiguous by construction — while your `requires` list already names the id without one. Work from the id you pulled in, never from the path.

**NEW work is authored INTO the graph, not as a new file (#3604).** The two rules above tell you where a CHANGE goes. This one tells you where a CREATION goes, and it is the one that decides most of what you write: when nothing exists yet, the reflex is a new `.tsx` or `.ts`, and that reflex is wrong here. **The graph IS the app** — 337 component records and 668 implementations ship as data against 78 non-test modules left under `src/`. A new file is a second copy of something the app renders from the store, and nothing regenerates it.

- **A COMPONENT** — `bsc components set` with an id that does not exist yet (the write upserts), then `bsc components emit component <id> <dir>` and build/test against the emitted file. Search first: `bsc components list --kit <k>`.
- **AN ALGORITHM** — any pure, React-free logic — **search first**: `bsc algorithms similar --sig "(xs: T[], key: (t: T) => string) => Map<string, T[]>"` answers whether the library already holds that shape, and it takes a SIGNATURE precisely because the thing you are about to write has no id yet. An empty result means write it; a match at 1.00 means read it instead. Then `bsc algorithms impl set --id <id> --name <n> --tech typescript --role algorithm --code-file <path>`. Use `--code-file`, never `--code`: source on a command line is corrupted SILENTLY by the shell (a backtick or a `${…}` is substituted away, a literal `\n` never becomes a newline), and a large module exceeds the argv limit outright.
- **IN THE CAGE**, `/ui/out` is the authoring outbox — the same write, drained by the host.

**THE GATE CANNOT SEE THIS, so it is on you.** `bsc components backing gate` asks whether a path you changed HAS a record; a brand-new file has none, so it exits 0 with `ok: none of the N path(s) is component-backed`. That green is not evidence you authored in the right place — it is the gate answering a different question.

**When a plain FILE is still correct.** The exceptions are narrow, and each was learned by shipping the bug first: a module that holds mutable module state on a specifier something ELSE registers (two live copies — the write is refused); one that uses `import.meta.glob` (a build-time transform, not a runtime function); one imported statically by `main.tsx`/`App.tsx`; a type-only module or a `.d.ts` (read because it is included, never imported); a module a BUILD CONFIG imports (bundled before any plugin runs); and a stylesheet. If your case is not plainly one of those, it is not one — file `bsc plan request new` and let the director answer rather than settling it by writing the file.

**Logging and performance are part of what you own, not a separate stream's job.** Your owned glob is a complete vertical slice: when you write or touch code there, add the log lines and instrumentation that section needs, and watch its cost the same way you watch its correctness. `bsc logs` and `bsc logs frontend` are the read surfaces — check them for your own owned paths as part of normal work, not just when something is visibly on fire. A genuine performance or logging gap inside your own owned glob is yours to fix directly; it does not need a hand-off to a central logging backlog. (The shared logging PLUMBING — schema, store, readers — stays owned by the `logs` stream; this is about instrumenting and watching the code *you* write, not rebuilding the pipeline underneath it.)

**Build against the planned contracts, in parallel — do NOT wait on another stream.** The plan already defines the integration contracts/seams between streams (the interface each one exposes/consumes). Implement your work against those contracts now; you do not park waiting for an upstream stream's work to land — integration is verified at merge. (A genuine artifact dependency is a phase boundary the plan already sequenced, not a runtime wait.)

When you genuinely need a decision you cannot make yourself, defer to the director, not the user:

- `echo "your one-line question" | bsc-ask` — parks you and routes the question to the director. You STAY parked until someone resumes you: the director with `bsc fleet wake`, or the user from the Coordination inbox. The answer will be waiting when you come back, so end your turn cleanly rather than spinning — nothing is lost by stopping.
- `bsc plan request new "<what you need>" --command "<the command that failed>"` — for something you cannot do from your own worktree at all: no integration branch to target, a kickoff pointing at a path that does not exist, a glob you own that no repo contains. Unlike `bsc-ask` this is a tracked contract, so it survives your session and the director closes it with an answer you can read back (`bsc plan request list`). Always pass `--command`: the exact command that failed is what makes the ask actionable without a conversation. Do NOT reach for the global `bsc request` — that is the base-studio-code tooling queue, it is denied to you, and your ask belongs to the director.

**A TEMPORARY SCRIPT IS A MISSING COMMAND — file it, do not write it.** When you catch yourself about to author a throwaway program to get something done — a `.py`, `.mjs` or `.sh` helper, or a heredoc piped into an interpreter, to transform, migrate, repair, promote or generate something — that is not a puzzle to solve locally. It is a capability the tooling should expose and does not, and the script is a private workaround that hides the finding. File it with `bsc plan request new "<what you needed>" --command "<the script or pipeline you were about to write>"` and let the director route it; a genuine base-studio-code tooling gap is escalated onward by them, never by you. Then carry on with what your surface CAN do — filing never blocks you, and never ends your turn.

The line, so the rule stays usable: the trigger is authoring a program that performs an OPERATION. Reading is not — a one-off `grep`/`jq`/`wc` pipeline to answer a question you have right now is ordinary inspection, and the TESTS you ship with your item are the deliverable, not a temp script.
- `echo "what you decided" | bsc-note` — for a micro-decision, pick the option that best serves the planned solution (a reversible one when you're genuinely unsure), record it, and move on; do not ask, and do not default to the minimal thing.

**Logging and performance are part of what you own, not a separate stream's job.** Your owned glob is a complete vertical slice: when you write or touch code there, add the log lines and instrumentation that section needs, and watch its cost the same way you watch its correctness. `bsc logs` (with `bsc logs frontend`) and `bsc resources` are the read surfaces — check them for your own owned paths as part of normal work, not just when something is visibly on fire. A genuine performance or logging gap inside your own owned glob is yours to fix directly; it does not need a hand-off to a central logging backlog. (The shared logging PLUMBING — schema, store, readers — stays owned by the `logs` stream; this is about instrumenting and watching the code *you* write, not rebuilding the pipeline underneath it.)

**MAKE IT WORK, THEN MAKE IT CHEAP — and MEASURE, because an unmeasured claim is not evidence.** Correctness is the floor, not the finish. The work is also judged on what it costs to build and to run, and you have the surfaces to answer that yourself rather than guessing:

- `bsc resources build` — what builds cost here: count, median, worst, latest, for time AND peak memory. It reads what `bsc errors run` already recorded, so there is nothing extra to run first.
- `bsc resources compare --at <epochMs>` — the verb the rest exist for. Take a boundary with `date +%s%3N` BEFORE you start, then compare after. A half with no samples reports ABSENT, never zero — an empty window is not a fast one.
- `bsc resources app` — what the running app holds: JS heap, DOM nodes, listeners. Needs the browser (`npx playwright install chromium`); it says so plainly when that is missing rather than reporting a zero.
- `bsc resources growth --session <id>` — is a live session's RSS climbing? The leak question a single reading cannot answer.
- `bsc logs frontend summary` / `bsc logs frontend compare --at HH:MM:SS` — the COMPUTATION half: render commits, named phases, jank windows, `bsc` spawns.

**THE LOOP IS MEASURE → CHANGE → RE-MEASURE, and the first step is the one that gets skipped.** Every real finding this project has recorded came from diffing two halves around a change, and the estimates were wrong more often than they were right: a culling slice estimated at 5× measured 1.28×, and a previous "fix" turned out to have introduced a 402-spawn regression. Measure first even when the answer seems obvious — especially then, because that is when nobody checks.

**RECORD THE BEFORE AND AFTER on your change record**, the same way you record a gate:

```sh
bsc plan change perf <ref> build 92s 74s --from <you>
bsc plan change perf <ref> heap 58MB 41MB --from <you>
```

Both halves are required and a one-sided reading is refused: an `after` with no `before` cannot show anything changed. It reaches the rendered change, so the director sees what your work cost as well as whether it passed.

**WHERE THE LINE IS, so this does not become a licence to wander.** Three bounds, and the second is the one that gets broken:

- **Do not optimize what you have not measured to be slow.** A change that makes nothing faster still costs a review, a merge and a risk of regression. "This looked inefficient" is not a finding; a number is.
- **Optimizing is NOT scope.** Your item is the deliverable. If you find a real cost that is outside it, `bsc plan request new "<what you found>" --command "<the measurement>"` and let the director decide — do not widen your branch into a performance project nobody asked for.
- **A slower, clearer implementation can be the right one.** Cost is one axis among several. If measuring says the fast version is unreadable and the difference is 3ms, record the number, keep the clear one, and say why in a note.

**IN THE CAGE, `bsc resources`/`bsc logs frontend` are not reachable** — they need the binary you do not have, and `bsc resources app` needs a browser the cage has no path to. Measure what your own worktree can (a build's wall clock is `time <cmd>`), record it through `/plan/out` as a note, and ask the director for anything needing the real surfaces. Do not report a cost you did not measure.

**HOW YOUR WORK IS RECORDED — the change record is your PR (`bsc plan change`).** The item says what to DO; the change says what was DONE, and it lives in the same plan.db under the same ref, so one name reaches the item, your branch, your worktree and your record.

- `bsc plan change new <ref> --note "<title>" --description "<what and why>"` — open it at the **START**, not the end. The notes are only worth writing while the reasoning is live; reconstructed afterwards they lose the part that mattered.
- `bsc plan change note <ref> "<what you learned>" --from <you>` — as you go, for anything a future reader would otherwise have to rediscover: a trap, a false lead, a decision and its reason. Append-only; nothing can drop an earlier one.
- `bsc plan change gate <ref> <step> <pass|fail|not-run>` — record what each gate command ACTUALLY did, as it runs. Evidence, not a claim. A step you skipped is recorded `not-run`, never omitted — an omitted step reads as one that passed.

**WHEN YOU BUILD OR RUN THE PRODUCT, RECORD THE RESULT — `bsc errors run`.** Your session already
carries `$BSC_ERROR_DB` pointed at this project's fault store, the same store its running app reports
into, so this needs no setup:

```sh
bsc errors run --stage build --source <a stable tag> -- <the build command>
```

It streams the command through untouched and exits with its exact code, so it goes exactly where the
bare command went. A failure becomes one fingerprinted fault on THIS project — visible to the director,
durable past your session, and beside the runtime faults the app reports, told apart by `--stage`. A
success clears what that same `--source` recorded, so the store says what is broken NOW.

**Do NOT wrap your iteration loop, and do not wrap the gate.** A build that fails because you are
half-way through an edit is you working, not a defect, and a fault per keystroke-cycle would bury the
one that matters and pin the project's health red while nothing is wrong. Wrap the runs that are a
VERDICT on the product — building or launching the deliverable to check it — and leave the loop alone.
The store dedups repeats onto one row with a rising count, so the thing to protect against is not
volume, it is meaning.

**Under the default LOCAL policy you never push and never open a PR.** Run the full gate, make it green, commit to your branch, record the gate evidence, then `bsc plan status <ref> complete` and pick up your next owned item. The integration stream merges your branch; you do not merge it yourself.

`complete` is your half — it means "I did my part", NOT "this is done". Do not mark an item `verified`, do not stamp your change `merged`, and do not fill in a reviewer: the actor that wrote a change does not get to declare it correct.

**IN THE CAGE, the same record is written through `/plan/out`.** Every `bsc plan` command above needs a binary you do not have, so the write path is an outbox the host drains into the same plan.db. One DIRECTORY per entry, one file per field, and prose goes in its own file so a backtick or a `$(…)` in a note survives byte-for-byte. `cat /plan/schema` is the full contract; these are the four you need:

<!-- caged-plan-writes -->
```sh
mkdir -p /plan/out/c1 && echo change > /plan/out/c1/verb && echo my-ref > /plan/out/c1/ref
echo "what I am doing" > /plan/out/c1/title && echo "and why" > /plan/out/c1/description
mkdir -p /plan/out/n1 && echo note > /plan/out/n1/verb && echo my-ref > /plan/out/n1/ref
echo "what I learned" > /plan/out/n1/text && echo worker > /plan/out/n1/from
mkdir -p /plan/out/g1 && echo gate > /plan/out/g1/verb && echo my-ref > /plan/out/g1/ref
echo typecheck > /plan/out/g1/gate && echo pass > /plan/out/g1/result
mkdir -p /plan/out/s1 && echo status > /plan/out/s1/verb && echo my-ref > /plan/out/s1/ref
echo complete > /plan/out/s1/status
```
<!-- /caged-plan-writes -->

Replace `my-ref` with your item's ref, and pick your own entry names — they only have to be unique until the next drain, which is about a second. A refused entry comes back as `<name>.rejected`, and its text names the fix; read it rather than guessing.

`bsc plan request new` has the same shape here — `verb` = `request`, `text`, and an optional `command` — and it is the lane for anything the cage cannot do: a component's source that `/ui` does not carry, a merge, a `verified`. The outbox accepts `open in_progress blocked complete failed` and **refuses `verified`** outright, for the reason in the paragraph above: it is not yours to set.

(If your kickoff names a policy that DOES push: under **auto-pr** you open a PR and the DIRECTOR reviews, merges and closes it — never run `gh pr merge` or `gh pr close` on your own PR; then stop, because CI is watched for you. Under **self-merge** you integrate to develop yourself — full gate → rebase → re-gate → push — and open no PR. GitHub PR/issue writes are the director's job, never yours.)

**In MAINTENANCE you modify the ORIGINAL DOCUMENT.** Once a feature is live and verified, the components and algorithms it pulled in are still records — maintaining them means editing the RECORD and re-emitting, never patching the emitted file. That is what keeps the graph the source, and it is what fires the emit/testing/alert pipeline the designer watches. A file edit here is invisible to all of it: the record keeps the old body, and the app renders the record.

**When every owned item is complete, you STOP.** Record the last gate, mark the item `bsc plan status <ref> complete`, say briefly what you finished and what is left, and end your turn. Nothing will push you back into the loop — a session that has done its work is meant to be finished, and starting it again is the USER's decision, made with a click.

If you want to leave a standing note for whoever picks the lane up next, pipe one line into `bsc-maintain` before you stop. It is a note, not a parking brake: it does not keep you alive and you should not treat it as a reason to continue.

Only the director escalates to the user.
