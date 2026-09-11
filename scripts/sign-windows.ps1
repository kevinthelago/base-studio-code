# Empty-safe Windows code-signing shim for bundle.windows.signCommand.
#
# NOTHING REFERENCES THIS FILE TODAY, AND THAT IS NOT A SIGN IT IS DEAD.
# `bundle.windows` in tauri.conf.json carries only `nsis` — the `signCommand` key that named this
# script was removed by 69f8802f8 ("build Windows unsigned + from main so the bundle succeeds", #890),
# and `.github/workflows/windows-asset.yml` builds from main partly FOR that fix, calling it
# "no-signCommand". So Windows signing is DISABLED, not retired, and this is the half that gets wired
# back when it returns.
#
# Recorded here rather than left to be rediscovered: a reachability sweep over scripts/ scores this
# file at zero references, which is exactly how a live-but-dormant tool gets swept. The reasoning is
# `zero references is not evidence of deadness` from
# `record-operations-belong-on-the-bsc-surface-not-in-scripts`, and this is a second instance of it
# after `guard-ref.mjs` (called from a git hook, in shell, which no grep over .mjs/.ts finds).
#
# To re-enable: restore `bundle.windows.signCommand` pointing at this file, and confirm release.yml's
# trusted-signing-cli install step still gates on AZURE_CLIENT_ID the way the note below describes.
# Tauri passes the artifact path as the first positional argument (%1 -> $FilePath).
#
# Behaviour:
#   - AZURE_CLIENT_ID absent/empty  -> exits 0 (unsigned build, no error)
#   - AZURE_CLIENT_ID present       -> calls trusted-signing-cli to sign $FilePath
#
# The corresponding install step in release.yml only runs when AZURE_CLIENT_ID is
# set, so trusted-signing-cli is guaranteed to be on PATH in the signing path.
param([string]$FilePath)

if (-not $env:AZURE_CLIENT_ID) { exit 0 }

trusted-signing-cli sign `
    --endpoint            $env:TRUSTED_SIGNING_ENDPOINT `
    --account-name        $env:TRUSTED_SIGNING_ACCOUNT `
    --certificate-profile $env:TRUSTED_SIGNING_PROFILE `
    --file-path           $FilePath
