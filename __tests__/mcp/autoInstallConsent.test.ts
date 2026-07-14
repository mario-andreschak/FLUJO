/**
 * Unit tests for the SEP-1024 install-consent POLICY (issue #98): the pure
 * decision layer + audit-entry builder. No IO, so no mocking needed.
 */
import {
  DEFAULT_MCP_AUTO_INSTALL_SETTINGS,
  McpAutoInstallSettings,
  normalizeAutoInstallSettings,
  registryNamespace,
  decideInstallConsent,
  planToAuditEntry,
} from '@/utils/mcp/autoInstallConsent';
import { ResolvedInstallPlan } from '@/utils/mcp/registry';

const settings = (over: Partial<McpAutoInstallSettings> = {}): McpAutoInstallSettings => ({
  ...DEFAULT_MCP_AUTO_INSTALL_SETTINGS,
  ...over,
});

describe('normalizeAutoInstallSettings', () => {
  it('applies safe defaults for a missing/partial blob', () => {
    expect(normalizeAutoInstallSettings(null)).toEqual(DEFAULT_MCP_AUTO_INSTALL_SETTINGS);
    expect(normalizeAutoInstallSettings({})).toEqual(DEFAULT_MCP_AUTO_INSTALL_SETTINGS);
    // Default MUST require consent and ship an empty allowlist (SEP-1024 safe default).
    expect(DEFAULT_MCP_AUTO_INSTALL_SETTINGS.requireConsent).toBe(true);
    expect(DEFAULT_MCP_AUTO_INSTALL_SETTINGS.namespaceAllowlist).toEqual([]);
    expect(DEFAULT_MCP_AUTO_INSTALL_SETTINGS.trustBrainStem).toBe(true);
  });

  it('drops non-string allowlist entries and coerces bad types', () => {
    const s = normalizeAutoInstallSettings({
      requireConsent: false,
      // @ts-expect-error intentionally malformed input
      namespaceAllowlist: ['ai.example', 42, '', null],
      // @ts-expect-error intentionally malformed input
      trustBrainStem: 'nope',
    });
    expect(s.requireConsent).toBe(false);
    expect(s.namespaceAllowlist).toEqual(['ai.example']);
    expect(s.trustBrainStem).toBe(true); // bad type falls back to default
  });
});

describe('registryNamespace', () => {
  it('extracts the segment before "/"', () => {
    expect(registryNamespace('ai.example/web-search')).toBe('ai.example');
    expect(registryNamespace('bare-name')).toBe('');
    expect(registryNamespace('/leading')).toBe('');
  });
});

describe('decideInstallConsent — generator', () => {
  it('allowInstall=true is the consent', () => {
    const d = decideInstallConsent({ caller: 'generator', settings: settings(), registryName: 'x/y', allowInstall: true });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('generator-allowinstall');
  });

  it('allowInstall=false blocks', () => {
    const d = decideInstallConsent({ caller: 'generator', settings: settings(), registryName: 'x/y', allowInstall: false });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('generator-not-allowed');
  });
});

describe('decideInstallConsent — authoring-tool (brain-stem)', () => {
  it('is trusted by default (trustBrainStem=true)', () => {
    const d = decideInstallConsent({ caller: 'authoring-tool', settings: settings(), registryName: 'x/y' });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('brainstem-trusted');
  });

  it('falls back to the consent gate when trustBrainStem is off', () => {
    const d = decideInstallConsent({
      caller: 'authoring-tool',
      settings: settings({ trustBrainStem: false }),
      registryName: 'x/y',
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('consent-required');
  });

  it('an allowlisted namespace passes even without brain-stem trust', () => {
    const d = decideInstallConsent({
      caller: 'authoring-tool',
      settings: settings({ trustBrainStem: false, namespaceAllowlist: ['ai.example'] }),
      registryName: 'ai.example/web-search',
    });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('namespace-allowlisted');
  });
});

describe('decideInstallConsent — interactive', () => {
  it('requires consent by default', () => {
    const d = decideInstallConsent({ caller: 'interactive', settings: settings(), registryName: 'ai.example/web-search' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('consent-required');
  });

  it('is allowed when consent is globally disabled', () => {
    const d = decideInstallConsent({
      caller: 'interactive',
      settings: settings({ requireConsent: false }),
      registryName: 'ai.example/web-search',
    });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('consent-disabled');
  });

  it('is allowed for an allowlisted namespace', () => {
    const d = decideInstallConsent({
      caller: 'interactive',
      settings: settings({ namespaceAllowlist: ['ai.example'] }),
      registryName: 'ai.example/web-search',
    });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('namespace-allowlisted');
  });
});

describe('planToAuditEntry — secrets are NAMES only', () => {
  const plan: ResolvedInstallPlan = {
    registryName: 'ai.example/web-search',
    resolvedName: 'ai.example/web-search',
    serverName: 'web-search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@example/web-search@1.0.0'],
    requiredEnvNames: ['SEARCH_API_KEY'],
    verificationStatus: 'unverified',
  };

  it('captures command/args/verification and the consent decision', () => {
    const decision = decideInstallConsent({ caller: 'generator', settings: settings(), registryName: plan.registryName, allowInstall: true });
    const entry = planToAuditEntry(plan, 'generator', decision, true);
    expect(entry.command).toBe('npx');
    expect(entry.args).toEqual(['-y', '@example/web-search@1.0.0']);
    expect(entry.requiredEnvNames).toEqual(['SEARCH_API_KEY']);
    expect(entry.verificationStatus).toBe('unverified');
    expect(entry.consent).toEqual({ allowed: true, reason: 'generator-allowinstall' });
    expect(entry.installed).toBe(true);
    expect(typeof entry.at).toBe('string');
  });

  it('never carries an env VALUE — the audit entry has no value-bearing env field', () => {
    const decision = decideInstallConsent({ caller: 'authoring-tool', settings: settings(), registryName: plan.registryName });
    const entry = planToAuditEntry(plan, 'authoring-tool', decision, false, 'some error');
    const serialized = JSON.stringify(entry);
    // Only the NAME may appear, and there is no "env"/values object at all.
    expect(serialized).toContain('SEARCH_API_KEY');
    expect(entry).not.toHaveProperty('env');
    expect(entry.installed).toBe(false);
    expect(entry.error).toBe('some error');
  });
});
