# Claude Design kickoff — Source connection pane (dynamic, per-source, planner-isolated credentials)

Paste this whole brief into a Claude Design session. Deliverable: functionless React **JSX skeletons** (Babel-standalone style, no real logic) for the **Source connection** surface and its states, using the exact design tokens below, so it drops into base-studio-code with minimal rewiring. Companion brief: `docs/migration-source-pane-kickoff.md` (the inventory / inferred-model / behavior-summary body that comes *after* connection). This brief covers the **connection front-half** only.

---

## 1. What you're designing

The **connection step** of base-studio-code's migration **Source** stage: where the user names the systems they're migrating *from* and connects to each one **read-only**, so the planner can scan its data, configurations, and behaviors.

The defining idea: **the connection surface is dynamic — it renders one connection page per source the user declares, and each page is shaped to that specific system.** If the user is migrating from **QuickBooks** and **Quickbase** into a custom solution, the pane shows **exactly two** connection pages — a QuickBooks page (an "Connect with Intuit" OAuth flow) and a Quickbase page (a realm + user-token form) — and nothing else. Declare Salesforce instead and you get the Salesforce OAuth page. The set of pages, and the fields on each, are **data-driven** from a per-connector spec.

The second defining idea: **credentials never reach the planning agent.** The user types secrets into a **native, app-owned** field; they're encrypted into the **OS keychain** and used only by base-studio-code's connectors. The planner (a Claude session) only ever receives the *results* of the scan — object lists, inferred schema, behavior summaries — **never the credentials**. This posture must be **visible and reassuring** in the design, not fine print.

## 2. Product context (so the design fits)

- **base-studio-code** is a desktop app (Tauri + React, dark-first) for running many Claude coding agents in parallel. Its flagship feature is the **project planner**: a pitch becomes a plan **one stage at a time** — context → repos → **source (this stage)** → deploy → features → … A fleet of agents then builds it.
- The planning page is a **split**: a live Claude terminal session on the left, and a **focused pane** on the right showing **one stage at a time**. The focused pane has a fixed vocabulary you must match:
  - a **stepper** (the stages, with status dots),
  - a **stage header** (title + a **gate pill** — "met" vs "N/M needed"),
  - a **scrolling body** (`.pp-scroll`, padding `14px 16px 18px`),
  - a **footer advance bar** (`← back` · `phase X of Y` · a primary **approve & continue →** action).
- You're designing the **body** of the Source stage's connection step; the stepper/header/footer already exist (show them lightly for context). This step sits **before** `features`/`structure` — what's scanned here dictates the structure the new app is built over.
- **Read-only, always (#782).** We read from the source and reproduce its data + behavior in the new app; we **never write back** into the system of record. Show the read-only posture as a calm badge near every source.
- **Multi-source is normal.** A migration often pulls from several systems at once (QuickBooks for finance + Quickbase for ops), all feeding **one** canonical Data Model. The surface must read comfortably with **1–4 declared sources**.

## 3. The security model — credentials never reach the planner (the defining constraint)

This is the part that most needs to be *legible* in the design. Convey it with structure and copy, not a warning banner.

- **Where secrets live:** the user enters credentials in this native pane. They are encrypted into the **OS keychain** (the app's secure store) and handed only to the Rust connector that uses them. They are **not** written to any plan file, prompt, or log.
- **What the planner sees:** the planning agent receives a **redacted connection handle** and the scan *results* — e.g. *"QuickBooks: connected as ‘Acme Co’ (Production) — credentials held by app"*. Never the token, password, or key.
- **Make it visible:**
  - A persistent, calm **"Planner-isolated"** affordance on the credential area — a small shield/`--info` chip reading something like **“🛡 Credentials stay on this device — the planning agent never sees them.”**
  - **Secret fields are masked** (`••••`) with a reveal toggle; once saved they collapse to a **“saved to keychain”** state (a `--success` chip, the value never re-shown in full).
  - A subtle **boundary visual** is welcome — e.g. a thin divider or label distinguishing the **“entered here (device)”** zone from the **“shared with planner”** zone (which lists only the redacted handle + discovered objects). This is the payoff diagram of the whole security story; make it quietly present.
- **READ-ONLY badge** near each source's connection — `--success`/`--info` tinted, reassurance not warning.

## 4. The flow (top to bottom within the stage body)

1. **Declare sources** — the user states which systems they're migrating from. A **searchable connector catalog** (tiles): QuickBooks, Quickbase, Salesforce, HubSpot, Microsoft Dynamics 365, NetSuite, SAP (OData), SQL database (Postgres/MySQL), REST / OpenAPI endpoint, CSV / data-export upload. The planner may **pre-propose** from the pitch (*"Detected: migrating from QuickBooks + Quickbase — connect them?"* with the two tiles pre-selected). The user adds/removes. **This selection is what makes the next section dynamic.**
2. **Per-source connection pages — the dynamic series.** One page per declared source. Present them as a **left rail of declared sources** (each showing its name, logo glyph, and connection status dot) with the **active source's connection form on the right**; or as stacked, individually-collapsible source cards. Each page renders **that connector's own form** (see §5) plus its connection state, read-only badge, and the planner-isolated affordance. Navigating between sources is a first-class interaction — the user works through them one at a time.
3. **Connected → scan hand-off.** Once a source is connected, its page shows a compact **scan summary** (what was found) and rolls up into the unified result that the rest of the Source body (companion brief) renders: inventory + inferred Data Model + **Platform Behavior Summary** (automations, business processes, derived logic). Show this as a "→ feeds the model" hand-off, not a finished load.
4. **Readiness summary / gate.** Sources declared + **every declared source connected** drives the stage gate. A one-liner: *"2 sources connected (QuickBooks · Quickbase) → scanning into the ‘Acme Core’ Data Model."*

## 5. The dynamic connection form (schema-driven — the heart of this brief)

Each connector declares a **`ConnectionSpec`**: `{ id, label, glyph, authMode, fields[] }`. The page **renders the form from the spec** — so the field set differs per source and adding a connector is just adding a spec (no new UI). Design the form **field-kind vocabulary** once, then show it composed differently per connector.

**Field kinds:** `oauth` (a provider connect button — no secret typed in-app), `text`, `secret` (masked + reveal + "saved to keychain"), `host`, `port`, `select` (e.g. environment), `toggle` (e.g. SSL), `file` (drag-drop upload).

**Connector matrix — design at least the bold ones, especially QuickBooks + Quickbase (the worked example):**

| Connector | `authMode` | Fields rendered |
|---|---|---|
| **QuickBooks Online** (Intuit) | OAuth 2.0 | `oauth` **“Connect with Intuit”** button · `select` environment (Production / Sandbox). After connect: read-only **Company / Realm** name + connected status. No secret typed in-app. |
| **Quickbase** | API user token | `host` **realm hostname** (`acme.quickbase.com`) · `text` App ID / DBID (optional, scopes the scan) · `secret` **User Token** (masked) |
| **Salesforce** | OAuth 2.0 | `oauth` **“Connect to Salesforce”** · `select` environment (Production / Sandbox). After: instance URL + connected user |
| HubSpot | OAuth 2.0 / Private-App token | `oauth` button **or** `secret` Private-App token |
| Microsoft Dynamics 365 | OAuth 2.0 (Azure AD) | `oauth` **“Connect with Microsoft”** · `text` org URL |
| NetSuite | Token-based auth | `text` Account ID · `secret` Consumer Key / Secret · `secret` Token ID / Secret (all masked) |
| SAP (OData) | Basic / OAuth | `text` service URL · `text` username · `secret` password |
| SQL database (Postgres / MySQL) | password | `host` host · `port` port · `text` database · `text` username · `secret` password · `toggle` SSL |
| REST / OpenAPI | API key / OAuth | `text` base URL · `secret` API key |
| CSV / data export | none | `file` drag-drop upload (the proven, credential-free path) |

For **OAuth** connectors, the in-app surface is a **button**, not credential fields — emphasize that no secret is typed locally (the token is obtained by the redirect and stored in the keychain). For **token/password** connectors, the `secret` fields carry the full masking + keychain-saved treatment and the planner-isolated chip.

Each connector page also previews **what it will contribute** once connected — both **data** and **behaviors** — so the user sees the dynamic page is system-specific: e.g. QuickBooks → *Customers, Invoices, Items, Payments* + *recurring-transaction rules*; Quickbase → *its apps/tables* + *form rules & Pipelines (automations)*; Salesforce → *objects + custom fields* + *validation rules, Flows / Process Builder, approval processes*.

## 6. States to design

1. **Declare — empty / proposed.** No sources yet. Friendly empty state; if the pitch names systems, the planner's **proposed sources** appear pre-selected (*"Detected: QuickBooks + Quickbase"*) with a one-tap confirm. Read-only + planner-isolated reassurance present.
2. **Per-source: not connected.** The connector's form rendered from its spec, empty; primary action **Connect** (OAuth) or **Save & connect** (token/password). Secret fields masked and empty.
3. **Per-source: connecting / authorizing.** OAuth redirect in progress, or a token being validated. A genuinely **live** moment — use pulse here. ("Authorizing with Intuit…", "Validating Quickbase token…")
4. **Per-source: connected + scanning.** Connected (status dot `--success`, secret collapsed to "saved to keychain"), the read-only badge firm, and the scan running — objects discovered, behaviors found. Live/pulse on the scan. Show the redacted handle that's shared with the planner.
5. **Per-source: connected (scanned).** Scan complete; the compact "what was found" summary (objects + behaviors counts) + the "→ feeds the model" hand-off.
6. **Per-source: error / auth failed.** Bad token / denied OAuth / unreachable host — `--danger`, a clear reason, retry. The gate is held until resolved or the source is removed.
7. **Multi-source.** QuickBooks **+** Quickbase both declared: the left rail shows both with their statuses; one connected, one mid-connect — and the readiness summary tallies *connected / declared*.
8. **Secret-saved detail.** The masked-then-saved transition for a `secret` field (the keychain-saved chip), demonstrating the "never re-shown" treatment.

Also show the **stage in the stepper** in two states for context: *active/in-progress* and *complete*, positioned **before** features/structure.

## 7. Design system — match these EXACTLY

Dark is the primary theme. Tokens (CSS custom properties — use them, don't hardcode hex):

```css
:root{
  --bg-canvas:oklch(0.13 0.005 250); --bg-panel:oklch(0.17 0.005 250);
  --bg-elev:oklch(0.21 0.006 250);   --bg-elev2:oklch(0.26 0.006 250);
  --border:oklch(0.30 0.006 250);    --border-soft:oklch(0.24 0.006 250);
  --fg:oklch(0.94 0.004 250); --fg-muted:oklch(0.66 0.008 250); --fg-dim:oklch(0.46 0.008 250);
  --accent:oklch(0.80 0.14 70); --accent-dim:oklch(0.55 0.10 70);
  --success:oklch(0.74 0.13 145); --info:oklch(0.72 0.10 230);
  --violet:oklch(0.72 0.12 300); --danger:oklch(0.68 0.18 25);
  --mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
  --sans:"Inter",-apple-system,"Segoe UI",system-ui,sans-serif;
  --r-sm:4px; --r-md:6px; --r-lg:10px;
}
```

Conventions (the rest of the app follows these — match them so the pane is indistinguishable):
- **Type:** titles/labels in `--sans`; all metadata, hostnames, field keys, tokens-masked, counts, and "code-ish" text in `--mono`. Section headers are small (10px) mono, uppercase, `letter-spacing:.08em`, `--fg-dim`.
- **Cards:** `background:var(--bg-panel)`, `border:1px solid var(--border-soft)`, `border-radius:var(--r-lg)`, ~`13–16px` padding. Nested rows on `--bg-elev` / `--bg-elev2`.
- **Pills/tags:** `border-radius:99px`, mono ~9.5px, tinted via `color-mix(in oklch, <hue>, transparent 88–90%)` background + `…transparent 70–78%` border. `--success` = connected / saved / read-only-ok; `--accent` = proposed / action-needed; `--info` = neutral / the planner-isolated chip / redacted handle; `--violet` = the Data Model / entities; `--danger` = auth-failed / unreachable; `--fg-dim` = inert.
- **Selectable tiles** (connector catalog): a tile grid; selected = `--accent` border + faint accent wash; hover lifts to `--bg-elev`. Each tile carries a connector **glyph** + label + a small `authMode` hint (`OAuth` / `token` / `upload`).
- **Connection status dot:** `not connected` (`--fg-dim`) · `connecting` (`--accent`, pulsing) · `connected` (`--success`) · `error` (`--danger`).
- **Secret field:** a mono input rendered as `••••••••` with a reveal (eye) toggle; once saved, replace the input with a `--success` **“saved to keychain”** chip + a "replace" affordance. Never render a stored secret in full.
- **Planner-isolated chip:** a calm `--info` shield chip on the credential zone — the security payoff, present but not alarming.
- **READ-ONLY badge:** a calm `--success`/`--info` pill near each source.
- **OAuth connect button:** an `--accent`-outlined button with the provider name ("Connect with Intuit", "Connect to Salesforce") — visually distinct from a plain submit, signalling a redirect.
- **Gate pill** in the header: "✓ sources connected" (success, `met`) vs "1/2 connected" (accent, `unmet`).
- **Footer advance bar:** `← back` · `phase X of Y` (mono, `--fg-dim`) · primary **approve & continue →** (accent fill, dark text; disabled = dim with a "still needed: connect Quickbase" reason).
- Keep it **dense and technical** but calm — an inspection + config surface, not marketing. No drop shadows except menus/modals. Pulse/animation only for genuinely-live status (connecting / scanning).
- Fonts via Google Fonts: `Inter` (400–700) + `JetBrains Mono` (400–600).

## 8. Data shape (use realistic sample data — the worked example)

Design against this concrete migration so the dynamic behavior is unmistakable:

- **Project:** migrate from **QuickBooks Online** (finance) **+ Quickbase** (operations) into a **custom solution**. The pitch named both, so the planner **proposes exactly these two** — and the pane renders **exactly two** connection pages, nothing else.
- **QuickBooks page** (OAuth): a **“Connect with Intuit”** button + Production/Sandbox toggle. Connected state: company **“Acme Co”**, **Production**, status `connected`. Redacted handle shared with planner: *"QuickBooks · Acme Co · Production (credentials held by app)."* Contributes: **Customers (2,940), Invoices (18,220), Items (430), Payments (12,118)** + behavior *"recurring-invoice rule."*
- **Quickbase page** (token): realm `acme.quickbase.com`, App ID `bqr2x…` (optional), **User Token** `••••••••` → after save, a `--success` **“saved to keychain”** chip. Contributes tables **Projects (1,204), Tickets (8,991), Vendors (310)** + behavior *"2 form rules · 1 Pipeline (auto-assign)."*
- **Unified target:** both feed an **“Acme Core”** Data Model; the readiness one-liner: *"2 of 2 sources connected → scanning into Acme Core."*
- **Gate:** show **"1/2 connected — needs: Quickbase"** in one state (QuickBooks done, Quickbase mid-token-entry) and fully green (`✓ sources connected`) in another.
- Include a **third state** swapping the declared set to a single **Salesforce** source (OAuth page) to prove the pages are genuinely driven by the declaration — different source ⇒ different page.

## 9. Deliverable

Functionless React JSX skeleton(s) (one file is fine; multiple states stacked or via a `state` prop) using the tokens above:
- the **Declare sources** catalog (empty + planner-proposed),
- the **dynamic per-source connection pages** rendered from a `ConnectionSpec` (at minimum **QuickBooks** OAuth + **Quickbase** token, plus one of Salesforce / SQL to show a different field set),
- the per-source **states** (not-connected · connecting · connected+scanning · scanned · error), the **secret-saved** transition, and the **multi-source** rail,
- the **security model** made legible (planner-isolated chip, masked secrets, the device-vs-planner boundary, read-only badges),
- the stepper/header/footer shown lightly for context, with this stage positioned **before** features/structure.

No real logic, no data fetching, no actual OAuth — just the structure, styling, the `ConnectionSpec`-driven rendering, and the sample data, the way the rest of `design/` is built.
