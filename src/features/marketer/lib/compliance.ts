// Compliance guardrails for outbound marketing content (#3150, epic #3145 P5) — a content item that
// fails these checks cannot reach "approved" (enforced by the store's approveContentItem action).
// Pure heuristic checks, not legal advice, but enough of a floor that an obviously-noncompliant
// draft — no unsubscribe link, no sender identity, raw PII — gets caught before it can be sent.

import type { ContentItem } from "./campaign";

export interface ComplianceViolation {
  code: string;
  message: string;
}

// SSN-shaped (123-45-6789) or a 13–16 digit run (credit-card-shaped), allowing common separators.
const PII_PATTERNS: RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(?:\d[ -]?){13,16}\b/,
];

const SOCIAL_CHAR_LIMIT = 300;

function checkEmailCompliance(item: ContentItem): ComplianceViolation[] {
  const v: ComplianceViolation[] = [];
  if (!/unsubscribe/i.test(item.body)) {
    v.push({ code: "missing-unsubscribe", message: "Email body must include an unsubscribe link (CAN-SPAM / GDPR)." });
  }
  if (!item.senderIdentity?.trim()) {
    v.push({ code: "missing-sender-identity", message: "Email requires a sender identity — company name + physical address (CAN-SPAM)." });
  }
  return v;
}

function checkSocialCompliance(item: ContentItem): ComplianceViolation[] {
  const v: ComplianceViolation[] = [];
  if (item.body.length > SOCIAL_CHAR_LIMIT) {
    v.push({ code: "over-length", message: `Social post exceeds the ${SOCIAL_CHAR_LIMIT}-character channel limit.` });
  }
  return v;
}

function checkContentCompliance(item: ContentItem): ComplianceViolation[] {
  const v: ComplianceViolation[] = [];
  if (PII_PATTERNS.some((re) => re.test(item.body))) {
    v.push({ code: "possible-pii", message: "Content appears to contain PII (an SSN- or card-shaped number) — remove it before approving." });
  }
  return v;
}

/** Every guardrail violation blocking `item` from being approved — the per-channel checks
 *  (email: unsubscribe + sender identity; social: length/ToS) plus the generic content checks
 *  (no-PII) that apply regardless of channel. */
export function complianceViolations(item: ContentItem): ComplianceViolation[] {
  const byChannel =
    item.channelKind === "email" ? checkEmailCompliance(item)
    : item.channelKind === "social" ? checkSocialCompliance(item)
    : [];
  return [...byChannel, ...checkContentCompliance(item)];
}

export function canApprove(item: ContentItem): boolean {
  return complianceViolations(item).length === 0;
}
