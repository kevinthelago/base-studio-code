# base-studio-code v1.0.0 — General Availability

The first stable release of base-studio-code: a desktop platform for running
many AI coding agents in parallel across multiple repositories, with a built-in
project planner that turns a pitch into a complete, executable GitHub project
structure.

---

## Headline features

### Project Planner
An app-owned planning session reads your codebase and walks you through a guided
discovery process — goal, scope, stack, architecture — then runs a feature
workshop (new project: feature-by-feature; existing project: section-by-section)
that produces:
- **GitHub structure**: one milestone per phase, one issue per feature, each
  carrying acceptance criteria, owned files, and dependency links.
- **Blueprints**: lifecycle-categorized workflow templates with configurable
  stages (Context → Repos → UI → Structure → Permissions → Automations → Skills).
  Blueprint Assistant generates and attaches skills to stages; blueprints accept
  Claude Design files and produce a design brief.
- **Planning autopilot**: a Settings toggle that runs the planner's stage
  progression automatically without manual prompting.

### Multi-agent Fleet
Launch a parallel fleet with one click. Each stream gets its own git worktree
and branch; the director coordinates without writing feature code:
- **Per-agent roles**: planner / worker / director / triage — least-privilege
  enforcement at the command, tool, and file-write level.
- **Flows**: configurable autonomy (continuous / checkpoint / confirm) and push
  strategies (auto-pr / push-confirm / commit-only / none).
- **Coordination protocol**: `bsc-blocked`, `bsc-ask`, `bsc-note` for
  cross-agent communication; auto-wake when a blocked dependency lands.
- **Issuer**: director routes new issues to owning streams mid-flight.

### Console + Pane Grid
- Tab/pane grid (up to 4×4 panes per tab, unlimited tabs).
- Swappable views per pane: Console, Files, Branches, Changes, Log.
- Stable project keys; fleet and triage tabs reuse by key, not name.
- GitHub-readiness probe surfaces git/gh/claude gaps before an agent hits them.

### Knowledge Store
Stack-tagged markdown blocks injected into agent prompts. Enables standardized
GitHub Actions configs, code-review checklists, and architecture patterns across
all projects.

### Mobile Tunnel (optional)
Drive the same agents from your phone via a zero-knowledge Cloudflare relay:
- **Noise IK** end-to-end encryption; the relay sees only ciphertext.
- QR-code pairing; view-only by default; host grants input per-session.
- Relay health probe in Settings; absolute room TTL for idle cleanup.

### Refactor & Cleanup Blueprint
LLM-graded dead-code scanning pipeline:
1. Scan — identifies dead-code candidates.
2. Verify — grades candidates; filters false positives.
3. Cleanup fleet — launches agents per confirmed unit; merges each to develop.

### Diagnostics
Host-environment preflight check (git, gh, claude availability) shown inline
per pane before any agent session starts.

### Release pipeline
Cross-platform installers built on every `v*` tag:
- macOS: universal DMG (Apple Silicon + Intel), ad-hoc signed.
- Windows: NSIS installer + MSI, unsigned.
- Linux: .deb + AppImage.

Windows code-signing infrastructure is wired and auto-activates when Azure
Trusted Signing secrets are provisioned (#108). macOS Developer ID signing
infrastructure is documented and ready for credentials (#119).

---

## Upgrade notes

- **macOS**: ad-hoc signed build. Clear quarantine after install:
  `xattr -cr /Applications/base-studio-code.app`
- **Windows**: unsigned build. SmartScreen will warn on first run —
  click **More info → Run anyway**.
- Signed releases follow as 1.0.x patches when signing certs are procured.

---

## What's next

- **#108** Windows code signing (Azure Trusted Signing — procurement pending)
- **#119** macOS notarization (Apple Developer ID — procurement pending)
- **Backlog (post-1.0)** tracked in the GitHub project
