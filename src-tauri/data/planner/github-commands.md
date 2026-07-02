## Useful gh commands (read-only — you inspect GitHub; you never mutate it)

```
gh api user                                    # confirm auth
gh repo list --limit 100 --json nameWithOwner  # all repos
gh issue list --repo {owner}/{repo}            # open issues
gh pr list   --repo {owner}/{repo}             # open PRs
```
