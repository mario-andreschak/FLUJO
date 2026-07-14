/**
 * SEP-1024 install-consent POLICY — the pure decision layer (issue #98).
 *
 * MCP SEP-1024 (finalized 2026-01-22) requires that any client supporting
 * one-click / programmatic local-server installation surfaces the EXACT,
 * untruncated resolved install command + arguments, requires explicit approval,
 * and offers cancel before executing. FLUJO's programmatic auto-install paths
 * (the /mcp-flows `install_mcp_server` authoring tool and the flow generator)
 * previously spawned third-party packages with no per-install preview.
 *
 * This module is the PURE (IO-free) policy: given who is asking and the current
 * settings, it decides whether an install may proceed without an interactive
 * consent prompt, and it defines the audit-entry shape. Kept dependency-light
 * (only types from ./registry) so it is unit-testable and importable from both
 * frontend and backend. All IO (loading settings, writing the audit log) lives
 * in `@/backend/services/mcp/autoInstall`.
 *
 * Trust model (BRAIN-STEM DECISION, 2026-07-14): caller-based, NOT namespace-
 * based. A registry namespace is self-asserted and attacker-influenceable, so
 * the meaningful boundary is WHO is asking:
 *   - generator:      the per-run `allowInstall` opt-in IS the consent.
 *   - authoring-tool: the /mcp-flows tool (the brain-stem's own hands) is
 *                     trusted by default via `trustBrainStem`.
 *   - interactive:    everything externally-influenced (Marketplace one-click,
 *                     chat-driven installs) requires consent by default.
 * The namespace allowlist ships EMPTY and is only an optional operator
 * convenience for auto-approving specific interactive installs. On EVERY path,
 * regardless of trust, an audit entry (command/args/names — never values) is
 * written before any spawn.
 */
import { ResolvedInstallPlan } from './registry';

/** Who initiated the install — the trust boundary SEP-1024 consent keys on. */
export type InstallCaller = 'authoring-tool' | 'generator' | 'interactive';

export interface McpAutoInstallSettings {
  /**
   * Gate interactive / externally-influenced installs (Marketplace one-click,
   * chat-driven). Default true (SEP-1024 safe default). Does NOT govern the two
   * trusted first-party headless callers (see trustBrainStem / generator).
   */
  requireConsent: boolean;
  /**
   * Optional operator convenience: registry namespaces (the part before "/",
   * e.g. "ai.keenable") whose interactive installs are auto-approved. Ships
   * EMPTY — it is explicitly NOT how the brain/generator paths are unblocked.
   */
  namespaceAllowlist: string[];
  /**
   * When true, the /mcp-flows `install_mcp_server` authoring tool bypasses the
   * interactive consent prompt (it never bypasses the audit log). Default true
   * to preserve the essential brain self-improvement flow.
   */
  trustBrainStem: boolean;
}

export const DEFAULT_MCP_AUTO_INSTALL_SETTINGS: McpAutoInstallSettings = {
  requireConsent: true,
  namespaceAllowlist: [],
  trustBrainStem: true,
};

/** Coerce a possibly-partial/untrusted stored blob into complete, valid settings. */
export function normalizeAutoInstallSettings(
  raw: Partial<McpAutoInstallSettings> | null | undefined
): McpAutoInstallSettings {
  const r = raw ?? {};
  return {
    requireConsent:
      typeof r.requireConsent === 'boolean'
        ? r.requireConsent
        : DEFAULT_MCP_AUTO_INSTALL_SETTINGS.requireConsent,
    namespaceAllowlist: Array.isArray(r.namespaceAllowlist)
      ? r.namespaceAllowlist.filter((n): n is string => typeof n === 'string' && n.length > 0)
      : [],
    trustBrainStem:
      typeof r.trustBrainStem === 'boolean'
        ? r.trustBrainStem
        : DEFAULT_MCP_AUTO_INSTALL_SETTINGS.trustBrainStem,
  };
}

/** Registry namespace = the segment before "/", e.g. "ai.keenable/web-search" → "ai.keenable". */
export function registryNamespace(registryName: string): string {
  if (typeof registryName !== 'string') return '';
  const slash = registryName.indexOf('/');
  return slash > 0 ? registryName.slice(0, slash) : '';
}

export type ConsentReason =
  | 'generator-allowinstall'
  | 'generator-not-allowed'
  | 'brainstem-trusted'
  | 'consent-disabled'
  | 'namespace-allowlisted'
  | 'consent-required';

export interface ConsentDecision {
  /** True when the install may proceed WITHOUT an interactive consent prompt. */
  allowed: boolean;
  reason: ConsentReason;
  message: string;
}

export interface ConsentInput {
  caller: InstallCaller;
  settings: McpAutoInstallSettings;
  registryName: string;
  /** Generator only: the per-generation `allowInstall` opt-in. */
  allowInstall?: boolean;
}

/**
 * Decide whether an install may proceed without an interactive consent prompt.
 * Pure — does no IO and never inspects secret values.
 */
export function decideInstallConsent(input: ConsentInput): ConsentDecision {
  const { caller, settings, registryName, allowInstall } = input;

  if (caller === 'generator') {
    return allowInstall === true
      ? {
          allowed: true,
          reason: 'generator-allowinstall',
          message: 'Approved by the per-generation allowInstall opt-in.',
        }
      : {
          allowed: false,
          reason: 'generator-not-allowed',
          message: 'Installing is not allowed in this generation (allowInstall is off).',
        };
  }

  if (caller === 'authoring-tool' && settings.trustBrainStem) {
    return {
      allowed: true,
      reason: 'brainstem-trusted',
      message: 'Approved: the /mcp-flows authoring tool is trusted (mcpAutoInstall.trustBrainStem).',
    };
  }

  if (!settings.requireConsent) {
    return {
      allowed: true,
      reason: 'consent-disabled',
      message: 'Approved: consent is not required (mcpAutoInstall.requireConsent is off).',
    };
  }

  const ns = registryNamespace(registryName);
  if (ns !== '' && settings.namespaceAllowlist.includes(ns)) {
    return {
      allowed: true,
      reason: 'namespace-allowlisted',
      message: `Approved: namespace "${ns}" is allowlisted.`,
    };
  }

  return {
    allowed: false,
    reason: 'consent-required',
    message:
      'Consent required: review the exact command and arguments, then approve this install (SEP-1024).',
  };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * One auditable install decision. Written BEFORE any spawn on every path. Carries
 * the resolved command/args + required env NAMES and the verification status —
 * NEVER env values, per FLUJO's secrets posture.
 */
export interface InstallAuditEntry {
  /** ISO timestamp. */
  at: string;
  caller: InstallCaller;
  registryName: string;
  resolvedName?: string;
  serverName?: string;
  transport?: string;
  command?: string;
  args?: string[];
  serverUrl?: string;
  /** Env-var / header NAMES only — never values. */
  requiredEnvNames?: string[];
  verificationStatus?: string;
  consent: { allowed: boolean; reason: ConsentReason };
  /** Whether the install actually ran (false = resolve-only / blocked by consent). */
  installed: boolean;
  error?: string;
}

/**
 * Build an audit entry from a resolved plan + consent decision. Pure and
 * secrets-safe: it only ever copies the plan's env NAMES, never values.
 */
export function planToAuditEntry(
  plan: ResolvedInstallPlan,
  caller: InstallCaller,
  decision: ConsentDecision,
  installed: boolean,
  error?: string
): InstallAuditEntry {
  return {
    at: new Date().toISOString(),
    caller,
    registryName: plan.registryName,
    resolvedName: plan.resolvedName,
    serverName: plan.serverName,
    transport: plan.transport,
    ...(plan.command ? { command: plan.command } : {}),
    ...(plan.args ? { args: plan.args } : {}),
    ...(plan.serverUrl ? { serverUrl: plan.serverUrl } : {}),
    requiredEnvNames: plan.requiredEnvNames,
    verificationStatus: plan.verificationStatus,
    consent: { allowed: decision.allowed, reason: decision.reason },
    installed,
    ...(error ? { error } : {}),
  };
}
