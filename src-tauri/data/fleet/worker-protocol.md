
## Fleet coordination protocol (auto-added — do not edit)

You are one of several parallel sessions building this project. Never stop to ask the user what to do with your work — not for direction, not for whether your work is done, and not for how to integrate it. Under the default auto-pr policy you open a PR for your work and the DIRECTOR reviews, merges, and closes it — you never merge or close your own PR — while you keep going through every owned issue without waiting on the merge. GitHub PR/issue writes are the director's job, not yours. Follow your push instruction.

**Build against the planned contracts, in parallel — do NOT wait on another stream.** The plan already defines the integration contracts/seams between streams (the interface each one exposes/consumes). Implement your work against those contracts now; you do not park waiting for an upstream stream's work to land — integration is verified at merge. (A genuine artifact dependency is a phase boundary the plan already sequenced, not a runtime wait.)

When you genuinely need a decision you cannot make yourself, defer to the director, not the user:

- `echo "your one-line question" | bsc-ask` — parks you and routes the question to the director, which answers and resumes you automatically.
- `bsc plan request new "<what you need>" --command "<the command that failed>"` — for something you cannot do from your own worktree at all: no integration branch to target, a kickoff pointing at a path that does not exist, a glob you own that no repo contains. Unlike `bsc-ask` this is a tracked contract, so it survives your session and the director closes it with an answer you can read back (`bsc plan request list`). Always pass `--command`: the exact command that failed is what makes the ask actionable without a conversation. Do NOT reach for the global `bsc request` — that is the base-studio-code tooling queue, it is denied to you, and your ask belongs to the director.
- `echo "what you decided" | bsc-note` — for a micro-decision, pick the option that best serves the planned solution (a reversible one when you're genuinely unsure), record it, and move on; do not ask, and do not default to the minimal thing.

If your push policy is auto-pr (the default), open a PR and the DIRECTOR reviews, merges, and closes it — never run gh pr merge or gh pr close on your own PR. (Only if your push policy is explicitly self-merge do you integrate your own work to develop — full gate -> rebase onto develop -> re-gate -> push — and open no PR.) Follow the push instruction in your kickoff. When you open a PR, stop -- CI runs and is watched for you; you will be told to continue (if it passed) or to fix the build and push (if it failed). Do not poll CI, close, merge, reopen, or duplicate the PR — the director owns its merge and close.

**When every owned issue is complete, you ENTER MAINTENANCE — you do not end.** Do not run `bsc-done`. Instead pipe a one-line standing note into `bsc-maintain` (e.g. `echo "owned issues complete — standing by" | bsc-maintain`): this parks you alive and ready. Stay available; the director dispatches new or regressed work in your lane (`bsc-assign`) and resumes you automatically — pick it up, carry it through your normal loop, then re-enter maintenance the same way. You remain a live maintainer of your section, not a closed session.

Only the director escalates to the user.
