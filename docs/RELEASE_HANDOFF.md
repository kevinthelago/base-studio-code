# Release handoff — maintainer checklist

Most of the release CI is already committed and wired. The remaining steps are:
1. **Step 0** — apply the `release.yml` workflow change (requires `workflow` scope on your token)
2. **Steps 1–2** — procurement: obtain signing credentials and add them as GitHub secrets
3. **Step 3** — push the `v1.0.0` tag to trigger the release build

> **Detailed procurement steps:** `docs/release-signing.md`

---

## Step 0 — Apply the workflow change (one-time, requires `workflow` scope)

The workflow diff below could not be pushed by the automated token (GitHub requires
`workflow` scope to write `.github/workflows/`). Apply it manually with your personal
token or via the GitHub web editor, then commit directly to `develop`:

```diff
--- a/.github/workflows/release.yml
+++ b/.github/workflows/release.yml
@@ after the "Install frontend dependencies" step, before "Build and release" @@
-      # WINDOWS-SIGNING (enable post-procurement, #108): once the Azure Trusted
-      # Signing secrets exist and tauri.conf.json has `bundle.windows.signCommand`,
-      # uncomment to sign the .exe/.msi during bundling. Kept disabled so unsigned
-      # CI builds don't fail for a missing cert. See docs/release-signing.md.
-      # - name: Azure Trusted Signing (Windows)
-      #   if: matrix.platform == 'windows-latest'
-      #   uses: azure/trusted-signing-action@v0
-      #   with:
-      #     azure-tenant-id: ${{ secrets.AZURE_TENANT_ID }}
-      #     azure-client-id: ${{ secrets.AZURE_CLIENT_ID }}
-      #     azure-client-secret: ${{ secrets.AZURE_CLIENT_SECRET }}
-      #     endpoint: ${{ secrets.TRUSTED_SIGNING_ENDPOINT }}
-      #     trusted-signing-account-name: ${{ secrets.TRUSTED_SIGNING_ACCOUNT }}
-      #     certificate-profile-name: ${{ secrets.TRUSTED_SIGNING_PROFILE }}
+      # Windows signing (#108): scripts/sign-windows.ps1 is called by
+      # bundle.windows.signCommand (tauri.conf.json). The script exits 0 when
+      # AZURE_CLIENT_ID is absent, so unsigned builds pass. The CLI is only
+      # installed when the secret is present — signing auto-activates on
+      # procurement, no code change required. See docs/release-signing.md.
+      - name: Install Trusted Signing CLI (Windows)
+        if: matrix.platform == 'windows-latest' && secrets.AZURE_CLIENT_ID != ''
+        run: dotnet tool install --global trusted-signing-cli

@@ in the "Build and release" step's env: block, after APPLE_SIGNING_IDENTITY @@
+          # Windows signing (#108) — passed to sign-windows.ps1 via signCommand.
+          # Empty when secrets are absent; the script exits 0 in that case.
+          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
+          AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
+          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
+          TRUSTED_SIGNING_ENDPOINT: ${{ secrets.TRUSTED_SIGNING_ENDPOINT }}
+          TRUSTED_SIGNING_ACCOUNT: ${{ secrets.TRUSTED_SIGNING_ACCOUNT }}
+          TRUSTED_SIGNING_PROFILE: ${{ secrets.TRUSTED_SIGNING_PROFILE }}

@@ in the releaseBody, replace the existing macOS note @@
-            > **macOS:** the app is currently unsigned/un-notarized. After dragging it
-            > to Applications, clear the download quarantine once:
+            > **macOS:** this build is unsigned/un-notarized. After dragging to
+            > Applications, clear the quarantine once:
             > `xattr -cr /Applications/base-studio-code.app`
+            >
+            > **Windows:** this build is unsigned. SmartScreen may warn on first
+            > run — click **More info → Run anyway**.
+            >
+            > Signed releases follow when signing certs are provisioned (#108/#119).
```

> **Note:** `scripts/sign-windows.ps1` and `tauri.conf.json`'s `signCommand` are
> already on `develop`. The macOS ad-hoc signing (`APPLE_SIGNING_IDENTITY: '-'`)
> is preserved — do NOT add `APPLE_CERTIFICATE` without all six APPLE_* secrets
> present, or the build hard-fails (see the comment block in `release.yml`).

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

Once Step 0 is applied and all six secrets are added, the `windows-latest` CI leg:
1. Installs `trusted-signing-cli` automatically
2. Signs each `.exe` and `.msi` via `scripts/sign-windows.ps1` during bundling

---

## Step 3 — Tag the release

```bash
git pull origin develop
git tag v1.0.0
git push origin v1.0.0
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
