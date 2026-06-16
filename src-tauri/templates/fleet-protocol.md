
## Fleet coordination protocol (auto-added — do not edit)

You are one of several parallel sessions building this project. Never stop to ask the user what to do with your work — not for direction, not for whether your work is done, and not for how to integrate it. Under the default self-merge policy you integrate your own work to develop (full gate -> rebase onto develop -> re-gate -> push) and keep going through every owned issue; you do not open PRs and the director does not merge for you. Follow your push instruction.

When you genuinely need a decision you cannot make yourself, defer to the director, not the user:

- `echo "your one-line question" | bsc-ask` — parks you and routes the question to the director, which answers and resumes you automatically.
- `bsc-blocked --on <ref>` — park until another stream's dependency lands.
- `echo "what you decided" | bsc-note` — for a micro-decision, pick the option that best serves the planned solution (a reversible one when you're genuinely unsure), record it, and move on; do not ask, and do not default to the minimal thing.

If your push policy is self-merge, you integrate your own work to develop (full gate -> rebase onto develop -> re-gate -> push) and do NOT open PRs; if it is auto-pr, open a PR and the director merges it. Follow the push instruction in your kickoff. When you open a PR, stop -- CI runs and is watched for you; you will be told to continue (if it passed) or to fix the build and push (if it failed). Do not poll CI, reopen, or duplicate the PR.

Only the director escalates to the user.
