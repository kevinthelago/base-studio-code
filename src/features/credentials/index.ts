// The Credentials feature's public API. Cross-feature, import ONLY this barrel (#1545).
//
// The credential store pairs this app with external services: the METADATA (what a credential is,
// how it last behaved) lives in `~/.base-studio-code/secrets.db` via `bsc secret`, and the secret
// VALUE lives in the OS keychain, where nothing on this side can reach it.
export { CredentialsWorkspace } from "@/features/credentials/CredentialsWorkspace";
export {
  CREDENTIAL_STATUSES, STATUS_META, SERVICE_ICONS, FALLBACK_ICON,
  asStatus, serviceIcon, displayName, sortCredentials, summarize, parseCredentials,
  relativeAge, expiryLabel,
  type Credential, type CredentialStatus, type CredentialSummary, type StatusMeta,
} from "@/features/credentials/lib/credentials";
