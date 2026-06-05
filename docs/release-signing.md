# Release signing & notarization

How `base-studio-code` desktop installers are signed and notarized so they install
without "Unknown publisher" (Windows) or Gatekeeper (macOS) warnings, and how the
credentials are wired into CI.

> **Status:** CI is wired to *consume* signing credentials, but the credentials
> themselves are **maintainer-gated, long-lead procurement** (days–weeks). Until
> the secrets below are populated, `release.yml` still builds and attaches
> **unsigned** artifacts — every signing step is a no-op when its secret is empty,
> so the pipeline never fails for lack of a cert. Populate the secrets to flip
> signing on; no code change required.
>
> Tracking: **#108** (Windows), **#119** (macOS), `B-macos-procure` (Apple
> enrollment + credential wiring). The human PURCHASE/ENROLL steps are flagged
> `⛔ MAINTAINER` below and surfaced via `bsc-blocked`.

---

## macOS — Developer ID signing + notarization (#119, `B-macos-procure`)

Apple requires a paid **Apple Developer Program** membership ($99/yr), a
**Developer ID Application** certificate, and **notarization** (a server-side
malware scan that staples a ticket to the bundle) before a `.dmg`/`.app`
distributed outside the App Store launches cleanly on a clean Mac.

### Maintainer checklist (gating — do first)

1. ⛔ **MAINTAINER — Enroll in the Apple Developer Program**
   <https://developer.apple.com/programs/enroll/> ($99/yr; identity validation can
   take days). Note the **Team ID** (10-char, e.g. `AB12CD34EF`).
2. ⛔ **MAINTAINER — Create a "Developer ID Application" certificate.**
   Xcode → Settings → Accounts → Manage Certificates → ➕ → *Developer ID
   Application* (or via the Developer portal → Certificates). This is **not** the
   "Apple Development" or "Mac App Distribution" cert — Developer ID is the only
   one valid for outside-the-App-Store distribution.
3. ⛔ **MAINTAINER — Export the cert + private key as a `.p12`** (Keychain Access →
   export, set a strong password). Base64-encode for CI:
   `base64 -i developer-id.p12 | pbcopy`.
4. ⛔ **MAINTAINER — Create an app-specific password** for notarization at
   <https://appleid.apple.com> → Sign-In & Security → App-Specific Passwords
   (label it `bsc-notary`). `notarytool` accepts Apple-ID + app-specific password,
   or an App Store Connect API key — we use the former for simplicity.
5. Record the signing identity string exactly as Keychain shows it, e.g.
   `Developer ID Application: Your Name (AB12CD34EF)`.

### GitHub secrets to add (Settings → Secrets and variables → Actions)

| Secret | Value | Used by |
|---|---|---|
| `APPLE_CERTIFICATE` | base64 of the `.p12` | keychain import |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password | keychain import |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: … (TEAMID)` | codesign |
| `APPLE_ID` | the Apple ID email | notarytool |
| `APPLE_PASSWORD` | the app-specific password (`bsc-notary`) | notarytool |
| `APPLE_TEAM_ID` | the 10-char Team ID | notarytool |

These are the exact env names [`tauri-action`](https://github.com/tauri-apps/tauri-action)
reads; `release.yml` already passes them through (empty ⇒ unsigned build, no
failure). When all six are present, the `macos-latest` matrix leg signs with the
Developer ID cert and notarizes + staples the universal `.dmg` automatically.

### Verifying a signed/notarized build

```bash
codesign -dv --verbose=4 "base-studio-code.app"          # Authority = Developer ID Application
spctl -a -vvv -t install "base-studio-code.app"          # source=Notarized Developer ID
xcrun stapler validate "base-studio-code.dmg"            # The validate action worked!
```

---

## Windows — code signing + verified publisher (#108)

Goal: signed `.exe` **and** the `.msi`/NSIS installer so UAC/SmartScreen show a
**verified publisher** instead of "Unknown publisher". Since June 2023, CA-issued
code-signing keys must live on an HSM or a cloud signer — so a local `.pfx` import
is no longer an option for fresh OV/EV certs; CI signing goes through a cloud
signer's API.

### Certificate options (pick one — see #108 for the cost/trust trade-offs)

| Option | Cost | CI | SmartScreen reputation |
|---|---|---|---|
| **Azure Trusted Signing** *(recommended)* | ~$10/mo | native action | OV-like, builds over time |
| OV via cloud eSigner (SSL.com / DigiCert KeyLocker) | ~$200–400/yr | vendor API | builds over time |
| EV via cloud eSigner | ~$300–700/yr | vendor API | **instant** |

> Recommendation: **Azure Trusted Signing** — cheapest, first-class GitHub Action,
> no token wrangling. Requires an Azure subscription and identity validation
> (org ≥ 3 yrs, or the individual path).

### Maintainer checklist (gating)

1. ⛔ **MAINTAINER — Procure the signing identity:** enroll in Azure Trusted
   Signing (or buy an OV/EV cert from a cloud-eSigner CA) and complete
   organization/identity validation (days–weeks).
2. ⛔ **MAINTAINER — Create the signing account/profile** (Azure: a Trusted
   Signing account + certificate profile) and a service principal / API
   credential for CI.

### GitHub secrets to add (Azure Trusted Signing path)

| Secret | Value |
|---|---|
| `AZURE_TENANT_ID` | service-principal tenant |
| `AZURE_CLIENT_ID` | service-principal app id |
| `AZURE_CLIENT_SECRET` | service-principal secret |
| `TRUSTED_SIGNING_ENDPOINT` | e.g. `https://eus.codesigning.azure.net` |
| `TRUSTED_SIGNING_ACCOUNT` | Trusted Signing account name |
| `TRUSTED_SIGNING_PROFILE` | certificate profile name |

### Config (already wired — auto-activates when secrets are present)

`tauri.conf.json` has `bundle.windows.signCommand` pointing to
`scripts/sign-windows.ps1`. That script exits 0 when `AZURE_CLIENT_ID` is absent,
so unsigned CI builds pass without a cert. When all six secrets are added,
`release.yml` installs `trusted-signing-cli` automatically and the script signs
each artifact — no code change required.

`bundle.publisher` is already set in `tauri.conf.json` (cosmetic publisher
metadata — independent of the cert).

### Verifying a signed build

```powershell
Get-AuthenticodeSignature .\base-studio-code_x64-setup.exe   # Status = Valid
signtool verify /pa /v .\base-studio-code_x64_en-US.msi      # timestamped, chains to a trusted root
```

---

## Linux (#120)

No signing identity required. `release.yml`'s `ubuntu-22.04` leg builds a `.deb`
and an `.AppImage` via `tauri-action` (bundle target `all`) and attaches them to
the release. (AppImages can optionally be GPG-signed later; out of scope for v1.0.)

---

## Out of scope

- **Tauri auto-updater signing key** (the `tauri signer generate` key behind the
  updater JSON) — unrelated to OS publisher trust; tracked separately.
- App Store / Microsoft Store distribution.
