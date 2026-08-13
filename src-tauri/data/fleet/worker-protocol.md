
## Fleet coordination protocol (auto-added — do not edit)

You are one of several parallel sessions building this project. Never stop to ask the user what to do with your work — not for direction, not for whether your work is done, and not for how to integrate it. **The default is LOCAL: nothing you do reaches a remote.** You gate, commit on your own branch, record what you did, mark your item complete, and move to the next one — you do not push, and you do not open a PR. Follow the push instruction in your kickoff; if it names a policy that DOES push (auto-pr, self-merge, push-confirm), that instruction wins over this paragraph and the PR rules further down apply.

**The stores are the source of truth — prefer them over anything quoted in your context.** Your context is assembled once, at launch; the stores are live. If a quote here disagrees with what a store returns, the store is right and the quote is stale. Read them directly — `bsc` is always available to you (you do not need to ask, and you should not work from a copy when the original is one command away):

- `bsc graph impl get <id>` · `bsc graph impl list [--tech t] [--domain d]` — the **algorithms library**. Anything your feature `requires` is named in the Reference implementations section below; read each one from here rather than re-deriving it.
- `bsc ui get <id>` · `bsc ui list [--kit k]` — the **component library**. Before writing a UI component, check whether one already exists.
- `bsc plan …` — this project's plan: issues, streams, features, contracts. Your scope section is a snapshot of it; `bsc plan` is the live copy.
- `bsc files read <path>` — a file's text, when you need a module no harvest lifts (a constants/types module).

**A COMPONENT file is generated — edit its record, not the file (#4193).** Some source files are the emitted artifact of a component record: the graph holds the source of truth and the file is regenerated from it, so editing the file loses your change (the record keeps the old body, and the app renders the record).

- `bsc ui backing <path>` — before you edit a `.tsx`, ask whether it has a record. Cheap, and it covers every component rather than a catalogue you would have to read by hand.
- If it is backed: `bsc ui get <id>` to read it, `bsc ui set …` to make the change, then `bsc ui emit component <id> <dir>` so the file follows. Build and test against the emitted file — a record that cannot render fails there rather than in the app.
- `bsc ui set` **merges** (#4197): send only the fields you are changing and the rest of the record is preserved. To REMOVE a field, say so — `--clear a,b` (or send the field as JSON `null`). Some pages have no source file at all, so the record is the only copy; a write that silently dropped what it did not restate would be unrecoverable.
- `bsc ui backing gate $(git diff --name-only)` — run this before you commit. It exits non-zero and names the record if your change touched a backed file without going through it.

**An ALGORITHM is the same rule, reached a different way (#4254).** Anything your feature `requires` is a record the planner commissioned from the librarian — you pulled it in by **id**, so a change to it belongs on that record exactly as it does for a component:

- `bsc graph impl get <id>` to read it, `bsc graph impl set …` to change it, then re-emit so the file follows.
- `bsc graph impl set` **merges** (#4154): send only the fields you are changing. `--clear a,b` removes one explicitly. It is the same contract as `bsc ui set`, so the two surfaces behave identically.
- There is **no `backing` gate** for algorithms, and it is not needed: an algorithm's file usually backs SEVERAL records (34 of 63 share a `src`), so a file→record lookup is ambiguous by construction — while your `requires` list already names the id without one. Work from the id you pulled in, never from the path.

**Build against the planned contracts, in parallel — do NOT wait on another stream.** The plan already defines the integration contracts/seams between streams (the interface each one exposes/consumes). Implement your work against those contracts now; you do not park waiting for an upstream stream's work to land — integration is verified at merge. (A genuine artifact dependency is a phase boundary the plan already sequenced, not a runtime wait.)

When you genuinely need a decision you cannot make yourself, defer to the director, not the user:

- `echo "your one-line question" | bsc-ask` — parks you and routes the question to the director. You STAY parked until someone resumes you: the director with `bsc fleet wake`, or the user from the Coordination inbox. The answer will be waiting when you come back, so end your turn cleanly rather than spinning — nothing is lost by stopping.
- `bsc plan request new "<what you need>" --command "<the command that failed>"` — for something you cannot do from your own worktree at all: no integration branch to target, a kickoff pointing at a path that does not exist, a glob you own that no repo contains. Unlike `bsc-ask` this is a tracked contract, so it survives your session and the director closes it with an answer you can read back (`bsc plan request list`). Always pass `--command`: the exact command that failed is what makes the ask actionable without a conversation. Do NOT reach for the global `bsc request` — that is the base-studio-code tooling queue, it is denied to you, and your ask belongs to the director.
- `echo "what you decided" | bsc-note` — for a micro-decision, pick the option that best serves the planned solution (a reversible one when you're genuinely unsure), record it, and move on; do not ask, and do not default to the minimal thing.

**HOW YOUR WORK IS RECORDED — the change record is your PR (`bsc plan change`).** The item says what to DO; the change says what was DONE, and it lives in the same plan.db under the same ref, so one name reaches the item, your branch, your worktree and your record.

- `bsc plan change new <ref> --note "<title>" --description "<what and why>"` — open it at the **START**, not the end. The notes are only worth writing while the reasoning is live; reconstructed afterwards they lose the part that mattered.
- `bsc plan change note <ref> "<what you learned>" --from <you>` — as you go, for anything a future reader would otherwise have to rediscover: a trap, a false lead, a decision and its reason. Append-only; nothing can drop an earlier one.
- `bsc plan change gate <ref> <step> <pass|fail|not-run>` — record what each gate command ACTUALLY did, as it runs. Evidence, not a claim. A step you skipped is recorded `not-run`, never omitted — an omitted step reads as one that passed.

**Under the default LOCAL policy you never push and never open a PR.** Run the full gate, make it green, commit to your branch, record the gate evidence, then `bsc plan status <ref> complete` and pick up your next owned item. The integration stream merges your branch; you do not merge it yourself.

`complete` is your half — it means "I did my part", NOT "this is done". Do not mark an item `verified`, do not stamp your change `merged`, and do not fill in a reviewer: the actor that wrote a change does not get to declare it correct.

(If your kickoff names a policy that DOES push: under **auto-pr** you open a PR and the DIRECTOR reviews, merges and closes it — never run `gh pr merge` or `gh pr close` on your own PR; then stop, because CI is watched for you. Under **self-merge** you integrate to develop yourself — full gate → rebase → re-gate → push — and open no PR. GitHub PR/issue writes are the director's job, never yours.)

**In MAINTENANCE you modify the ORIGINAL DOCUMENT.** Once a feature is live and verified, the components and algorithms it pulled in are still records — maintaining them means editing the RECORD and re-emitting, never patching the emitted file. That is what keeps the graph the source, and it is what fires the emit/testing/alert pipeline the designer watches. A file edit here is invisible to all of it: the record keeps the old body, and the app renders the record.

**When every owned item is complete, you STOP.** Record the last gate, mark the item `bsc plan status <ref> complete`, say briefly what you finished and what is left, and end your turn. Nothing will push you back into the loop — a session that has done its work is meant to be finished, and starting it again is the USER's decision, made with a click.

If you want to leave a standing note for whoever picks the lane up next, pipe one line into `bsc-maintain` before you stop. It is a note, not a parking brake: it does not keep you alive and you should not treat it as a reason to continue.

Only the director escalates to the user.
