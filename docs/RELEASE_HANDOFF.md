# Release handoff — maintainer checklist

CI is fully wired for signed/notarized releases. The only remaining step is
**procurement**: the maintainer must obtain the signing credentials and add them
as GitHub secrets. When the secrets are present, signing activates automatically
— no code change required.

> **Detailed procurement steps:** `docs/release-signing.md`

---

## Step 0 — Apply the workflow change (one-time, requires `workflow` scope)

The signing install step and secret env vars could not be committed to
`.github/workflows/release.yml` in the automated PR (GitHub requires `workflow`
scope on the token). Apply this diff manually before adding the signing secrets:

```diff
--- a/.github/workflows/release.yml
+++ b/.github/workflows/release.yml
@@ after the "Install frontend dependencies" step, before "Build and release" @@
+      # Install the Azure Trusted Signing CLI when Windows secrets are present.
+      # The CLI is called by scripts/sign-windows.ps1 via bundle.windows.signCommand;
+      # the script exits 0 when AZURE_CLIENT_ID is absent so unsigned builds pass.
+      # No action needed when secrets arrive — signing auto-activates. (#108)
+      - name: Install Trusted Signing CLI (Windows)
+        if: matrix.platform == 'windows-latest' && secrets.AZURE_CLIENT_ID != ''
+        run: dotnet tool install --global trusted-signing-cli
+
@@ in the "Build and release" step's env: block @@
+          # Windows signing (#108) — passed to sign-windows.ps1 via signCommand.
+          # Empty when secrets are absent; the script exits 0 in that case.
+          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
+          AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
+          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
+          TRUSTED_SIGNING_ENDPOINT: ${{ secrets.TRUSTED_SIGNING_ENDPOINT }}
+          TRUSTED_SIGNING_ACCOUNT: ${{ secrets.TRUSTED_SIGNING_ACCOUNT }}
+          TRUSTED_SIGNING_PROFILE: ${{ secrets.TRUSTED_SIGNING_PROFILE }}
```

> **Note:** `scripts/sign-windows.ps1` and `tauri.conf.json`'s `signCommand` are
> already committed. Only the workflow file remains. The full target state of
> `release.yml` is on the `release-eng-signing` branch if it exists.

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

Once all six secrets are added, the `macos-latest` CI leg signs and notarizes
the universal `.dmg` automatically on every tagged release.

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

Once all six secrets are added, the `windows-latest` CI leg:
1. Installs `trusted-signing-cli` automatically
2. Signs each `.exe` and `.msi` via `scripts/sign-windows.ps1` during bundling

---

## Step 3 — Tag a release

```bash
git tag v1.0.0
git push origin v1.0.0
```

The `release.yml` workflow triggers on `v*` tags and builds signed installers for
all three platforms, generating release notes from merged PRs automatically.

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
