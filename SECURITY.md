# Security Policy

## Supported Versions

Only the latest release is actively supported with security fixes.

| Version | Supported |
|---|---|
| Latest | ✅ |
| Older  | ❌ |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities privately by emailing **kevinthelago@gmail.com**. Include:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Affected versions, if known

You can expect an acknowledgement within 48 hours. We aim to release a fix within 14 days for critical issues.

## Scope

This project handles:

- **API keys** (Anthropic Claude API key, GitHub tokens) stored via `tauri-plugin-store` in the OS keychain/app data directory — never committed to source
- **PTY sessions** — shell access is local to the host machine only
- **WebSocket tunnel** — token-authenticated bridge between desktop and mobile companion (not yet implemented; see issue #35)

## Out of Scope

- Vulnerabilities in upstream dependencies (report those to the relevant maintainer)
- Theoretical vulnerabilities without a practical exploit path
