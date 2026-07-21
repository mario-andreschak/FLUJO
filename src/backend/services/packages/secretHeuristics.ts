/**
 * Heuristic (offline, deterministic) secret detector for package export
 * (issue #195).
 *
 * Layer 1 of the two-layer detection: pure regex + entropy rules over the
 * `{ location, text }` slices produced by `secretScanTargets.ts`. Always on,
 * never leaves the machine. Reuses the repo's existing secret-keyword helpers
 * (`isSecretEnvVar` / `isSecretHeaderKey`) for `key=value` / `header: value`
 * shaped assignments, and adds regexes for absolute paths, `owner/repo` slugs,
 * credential-bearing URLs, emails, bearer tokens and generic high-entropy
 * strings.
 *
 * Output: `SecretProposal[]` (`source: 'heuristic'`). Overlapping matches are
 * resolved by a fixed rule priority so a credential-bearing URL is not also
 * reported as a bare email/path inside it.
 */
import { isSecretEnvVar } from '@/utils/shared/common';
import { SECRET_PLACEHOLDER_REGEX } from '@/shared/types/package/constants';
import {
  secretProposalId,
  toProposalSecretName,
  type SecretKind,
  type SecretProposal,
} from '@/shared/types/package/secretProposal';
import type { ScanTarget } from './secretScanTargets';

/** Default Shannon-entropy threshold (bits/char) for the generic-token rule. */
export const DEFAULT_ENTROPY_THRESHOLD = 3.5;
/** Minimum length a bare token must reach before the entropy rule considers it. */
export const MIN_ENTROPY_TOKEN_LENGTH = 20;

export interface HeuristicOptions {
  /** Override the entropy threshold (bits/char). */
  entropyThreshold?: number;
  /** Turn the (noisier) high-entropy generic-token rule off. Default on. */
  enableEntropy?: boolean;
}

/** Shannon entropy in bits/char of a string. 0 for empty. */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

interface RawMatch {
  start: number;
  end: number;
  value: string;
  kind: SecretKind;
  priority: number; // lower wins on overlap
  rationale: string;
}

/** A rule = a global regex + how to interpret its matches. */
interface Rule {
  re: RegExp;
  kind: SecretKind;
  priority: number;
  rationale: string;
  /** Which capture group is the secret span (default 0 = whole match). */
  group?: number;
}

const RULES: Rule[] = [
  {
    // https://user:pass@host/... — credentials embedded in a URL.
    re: /\bhttps?:\/\/[^/\s:@]+:[^/\s:@]+@[^\s"'<>]+/gi,
    kind: 'url-cred',
    priority: 1,
    rationale: 'URL with embedded credentials',
  },
  {
    // Authorization-style bearer tokens.
    re: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/gi,
    kind: 'token',
    priority: 2,
    rationale: 'Bearer token',
    group: 1,
  },
  {
    // Email addresses.
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    kind: 'email',
    priority: 3,
    rationale: 'Email address',
  },
  {
    // Windows absolute paths: C:\Users\... (at least one backslash segment).
    re: /\b[A-Za-z]:\\[^\s"'<>|?*]+/g,
    kind: 'path',
    priority: 4,
    rationale: 'Windows absolute file path',
  },
  {
    // POSIX absolute paths: /home/alice/... (>= 2 segments, not a bare "/x").
    re: /(?<![A-Za-z0-9._~:/])\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g,
    kind: 'path',
    priority: 5,
    rationale: 'POSIX absolute file path',
  },
  {
    // owner/repo slug: two GitHub-name-shaped tokens separated by a single slash.
    re: /(?<![A-Za-z0-9._/-])[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})(?![A-Za-z0-9._/-])/g,
    kind: 'repo',
    priority: 6,
    rationale: 'owner/repo slug',
  },
];

/** Assignment rule: `SECRET_ISH_KEY = value` / `secret-ish-key: value`. */
const ASSIGNMENT_RE = /(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_-]{1,64})\s*[:=]\s*("[^"]{4,}"|'[^']{4,}'|[^\s"']{6,})/g;

/** Does a span contain a `{{secret.NAME}}` placeholder? Then it is already handled. */
function hasPlaceholder(value: string): boolean {
  return new RegExp(SECRET_PLACEHOLDER_REGEX.source).test(value);
}

/** A crude test that a matched token "looks secret-ish" enough for the entropy rule. */
function looksLikeToken(token: string, threshold: number): boolean {
  if (token.length < MIN_ENTROPY_TOKEN_LENGTH) return false;
  const hasLetter = /[A-Za-z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  if (!hasLetter || !hasDigit) return false; // words and pure numbers are not tokens
  return shannonEntropy(token) >= threshold;
}

function collectRuleMatches(text: string): RawMatch[] {
  const matches: RawMatch[] = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const groupIdx = rule.group ?? 0;
      const value = m[groupIdx];
      if (!value) continue;
      const start = m.index + (groupIdx > 0 ? m[0].indexOf(value) : 0);
      matches.push({
        start,
        end: start + value.length,
        value,
        kind: rule.kind,
        priority: rule.priority,
        rationale: rule.rationale,
      });
      if (re.lastIndex === m.index) re.lastIndex++; // zero-width guard
    }
  }
  return matches;
}

function collectAssignmentMatches(text: string): RawMatch[] {
  const matches: RawMatch[] = [];
  const re = new RegExp(ASSIGNMENT_RE.source, ASSIGNMENT_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const key = m[1];
    let value = m[2];
    if (!isSecretEnvVar(key)) continue;
    // Unwrap simple quotes so the excerpt is the raw value.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value || hasPlaceholder(value)) continue;
    const start = m.index + m[0].indexOf(value, key.length);
    matches.push({
      start,
      end: start + value.length,
      value,
      kind: 'token',
      priority: 2, // same tier as bearer tokens — strong signal
      rationale: `Value assigned to secret-like key "${key}"`,
    });
  }
  return matches;
}

function collectEntropyMatches(text: string, threshold: number): RawMatch[] {
  const matches: RawMatch[] = [];
  const re = /[A-Za-z0-9._~+/=-]{20,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const token = m[0];
    if (!looksLikeToken(token, threshold)) continue;
    matches.push({
      start: m.index,
      end: m.index + token.length,
      value: token,
      kind: 'token',
      priority: 7,
      rationale: `High-entropy string (${shannonEntropy(token).toFixed(2)} bits/char)`,
    });
  }
  return matches;
}

/** Greedily keep non-overlapping matches, preferring lower priority then longer. */
function resolveOverlaps(matches: RawMatch[]): RawMatch[] {
  const sorted = [...matches].sort(
    (a, b) => a.priority - b.priority || b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  const kept: RawMatch[] = [];
  for (const cand of sorted) {
    const overlaps = kept.some((k) => cand.start < k.end && k.start < cand.end);
    if (!overlaps) kept.push(cand);
  }
  return kept.sort((a, b) => a.start - b.start);
}

const NAME_PREFIX: Record<SecretKind, string> = {
  path: 'PATH',
  repo: 'REPO',
  token: 'TOKEN',
  email: 'EMAIL',
  'url-cred': 'URL',
  name: 'NAME',
  other: 'SECRET',
};

/** Build a friendly secret-name slug from a matched excerpt + its kind. */
export function suggestSecretName(kind: SecretKind, excerpt: string): string {
  let raw = excerpt;
  if (kind === 'path') {
    const parts = excerpt.split(/[\\/]/).filter(Boolean);
    raw = parts[parts.length - 1] || excerpt;
  } else if (kind === 'email') {
    raw = excerpt.split('@')[0] || excerpt;
  } else if (kind === 'repo') {
    raw = excerpt.replace(/\//g, '_');
  } else if (kind === 'url-cred') {
    raw = excerpt.replace(/^https?:\/\//i, '').split(/[/:@]/)[0] || excerpt;
  } else if (kind === 'token') {
    raw = excerpt.slice(0, 8);
  }
  return toProposalSecretName(NAME_PREFIX[kind], raw);
}

/**
 * Run the heuristic detector over a batch of scan targets. Deterministic and
 * fully offline. Duplicate `location + excerpt` spans within the batch are
 * collapsed to a single proposal.
 */
export function detectHeuristicSecrets(
  targets: ScanTarget[],
  options: HeuristicOptions = {},
): SecretProposal[] {
  const threshold = options.entropyThreshold ?? DEFAULT_ENTROPY_THRESHOLD;
  const enableEntropy = options.enableEntropy !== false;
  const proposals: SecretProposal[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    const raw = [
      ...collectRuleMatches(target.text),
      ...collectAssignmentMatches(target.text),
      ...(enableEntropy ? collectEntropyMatches(target.text, threshold) : []),
    ].filter((m) => !hasPlaceholder(m.value));

    for (const match of resolveOverlaps(raw)) {
      const key = `${target.location} ${match.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      proposals.push({
        id: secretProposalId(target.location, match.value),
        location: target.location,
        excerpt: match.value,
        kind: match.kind,
        source: 'heuristic',
        suggestedSecretName: suggestSecretName(match.kind, match.value),
        rationale: match.rationale,
      });
    }
  }
  return proposals;
}
