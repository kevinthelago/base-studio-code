# Empty-safe Windows code-signing shim for bundle.windows.signCommand.
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
