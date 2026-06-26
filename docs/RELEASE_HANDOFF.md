# Release handoff — maintainer checklist

base-studio-code currently ships **unsigned** installers on every platform
(v1.0.0–v1.0.4 were all released unsigned). This checklist is what a maintainer does
to **enable code-signing on a future release** — none of it is required to cut an
(unsigned) build. The steps are:
1. **Step 0** — wire the Windows signing step in `release.yml` (not yet applied; requires `workflow` scope on your token)
2. **Steps 1–2** — procurement: obtain signing credentials and add them as GitHub secrets
3. **Step 3** — tag the release to trigger the build

> **Detailed procurement steps:** `docs/release-signing.md`

---

## Step 0 — Wire the Windows signing step (one-time, requires `workflow` scope)

Windows signing is **not wired yet**: `tauri.conf.json`'s `bundle.windows` is empty
(`{}`), so nothing signs the `.exe`/`.msi` today. Two pieces are staged but not
connected — a commented-out `azure/trusted-signing-action` block in `release.yml`
(already scoped to the `windows-2022` leg) and `scripts/sign-windows.ps1`, a shim
that exits 0 when `AZURE_CLIENT_ID` is absent. Pick **one** approach and apply it.
Writing `.github/workflows/` needs a token with `workflow` scope (the automated token
can't push it), so apply manually with your PAT or the GitHub web editor, then commit
to `develop`:

- **A — `signCommand` shim:** set `bundle.windows.signCommand` in `tauri.conf.json` to
  invoke `scripts/sign-windows.ps1`; in `release.yml`'s `windows-2022` leg add a step
  `dotnet tool install --global trusted-signing-cli` guarded by
  `secrets.AZURE_CLIENT_ID != ''`, and pass the six `AZURE_*` / `TRUSTED_SIGNING_*`
  secrets through the build step's `env:`.
- **B — Azure action:** uncomment the existing `azure/trusted-signing-action@v0` block
  in `release.yml` and supply the same six secrets.

Either way, also update the `releaseBody` to note the build is unsigned until the
secrets are present (Windows SmartScreen → **More info → Run anyway**).

> **Note:** the macOS ad-hoc signing (`APPLE_SIGNING_IDENTITY: '-'`) is preserved — do
> NOT add `APPLE_CERTIFICATE` without all six `APPLE_*` secrets present, or the build
> hard-fails (see the comment block in `release.yml`).

---

## Step 1 — macOS notarization (#119)

Populate these six GitHub secrets (**Settings → Secrets and variables → Actions**):

| Secret | Source |
|---|---|
| `APPLE_CERTIFICATE` | base64 of your Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | an app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | 10-char Team ID from the Developer portal |

**Prerequisites (⛔ maintainer-gated):**
- [ ] Enrolled in the [Apple Developer Program](https://developer.apple.com/programs/enroll/) ($99/yr)
- [ ] Developer ID Application certificate created and exported as `.p12`
- [ ] App-specific password created for `notarytool`

When all six secrets are present, replace `APPLE_SIGNING_IDENTITY: '-'` in
`release.yml` with the six `APPLE_*` env vars, and the `macos-latest` CI leg
signs and notarizes the universal `.dmg` on every tagged release.

---

## Step 2 — Windows code signing (#108)

Populate these six GitHub secrets:

| Secret | Source |
|---|---|
| `AZURE_CLIENT_ID` | service-principal app ID |
| `AZURE_CLIENT_SECRET` | service-principal secret |
| `AZURE_TENANT_ID` | Azure tenant ID |
| `TRUSTED_SIGNING_ENDPOINT` | e.g. `https://eus.codesigning.azure.net` |
| `TRUSTED_SIGNING_ACCOUNT` | Trusted Signing account name |
| `TRUSTED_SIGNING_PROFILE` | certificate profile name |

**Prerequisites (⛔ maintainer-gated):**
- [ ] Azure subscription with [Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/) set up (~$10/mo)
- [ ] Identity validation complete (org ≥ 3 years, or individual path)
- [ ] Service principal created with Trusted Signing Certificate Profile Signer role

Once Step 0 is applied and all six secrets are added, the `windows-2022` CI leg:
1. Installs `trusted-signing-cli` automatically
2. Signs each `.exe` and `.msi` via `scripts/sign-windows.ps1` during bundling

---

## Step 3 — Tag the release

```bash
git pull origin develop
git tag vX.Y.Z          # the version in package.json / tauri.conf.json
git push origin vX.Y.Z
```

The `release.yml` workflow triggers on `v*` tags and builds installers for all
three platforms, attaching them to a draft release with auto-generated PR notes.

---

## Verification

After the first signed release, confirm with:

```bash
# macOS
codesign -dv --verbose=4 "base-studio-code.app"
spctl -a -vvv -t install "base-studio-code.app"

# Windows (PowerShell)
Get-AuthenticodeSignature .\base-studio-code_x64-setup.exe
```

See `docs/release-signing.md` for the complete verification commands.
