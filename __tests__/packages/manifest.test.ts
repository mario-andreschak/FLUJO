/**
 * Zod validation tests for the package manifest schema (issue #198).
 */
import { parsePackageManifest, PACKAGE_MANIFEST_SCHEMA_VERSION } from '@/shared/types/packages/manifest';

const validManifest = () => ({
  schemaVersion: PACKAGE_MANIFEST_SCHEMA_VERSION,
  name: 'my-pkg',
  version: '1.0.0',
  publisher: 'acme',
  description: 'A test package',
  secrets: [{ key: 'API_KEY', label: 'API key', required: true, targets: ['model:My GPT'] }],
  mcpServers: [
    { localName: 'web', ref: { kind: 'registry', registryName: 'ai.keenable/web-search' }, envFromSecret: { WEB_KEY: 'API_KEY' } },
    { localName: 'remote', ref: { kind: 'remote', transport: 'streamable', serverUrl: 'https://example.com/mcp' } },
  ],
  models: [{ name: 'gpt-4o', displayName: 'My GPT', provider: 'openai', apiKeySecret: 'API_KEY' }],
  flows: [{ id: 'local-root', name: 'Root', nodes: [], edges: [], description: 'kept', folder: 'Pkg' }],
  plannedExecutions: [{ name: 'Nightly', flowId: 'local-root', prompt: 'go', trigger: { type: 'schedule', cron: '0 0 * * *' } }],
});

describe('parsePackageManifest', () => {
  it('accepts a well-formed manifest and returns the typed result', () => {
    const result = parsePackageManifest(validManifest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe('my-pkg');
      expect(result.manifest.mcpServers).toHaveLength(2);
    }
  });

  it('preserves extra Flow fields via catchall (description, folder)', () => {
    const result = parsePackageManifest(validManifest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const flow = result.manifest.flows![0] as Record<string, unknown>;
      expect(flow.description).toBe('kept');
      expect(flow.folder).toBe('Pkg');
    }
  });

  it('rejects an unknown schema version', () => {
    const bad = { ...validManifest(), schemaVersion: '99' };
    const result = parsePackageManifest(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('schemaVersion');
  });

  it('rejects a missing name', () => {
    const bad = validManifest() as Record<string, unknown>;
    delete bad.name;
    const result = parsePackageManifest(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('name');
  });

  it('rejects an mcpServer with an unknown ref kind', () => {
    const bad = validManifest();
    (bad.mcpServers[0] as { ref: unknown }).ref = { kind: 'ftp', url: 'x' };
    const result = parsePackageManifest(bad);
    expect(result.ok).toBe(false);
  });

  it('accepts a minimal manifest with no entities', () => {
    const result = parsePackageManifest({ schemaVersion: '1', name: 'empty', version: '0.0.1' });
    expect(result.ok).toBe(true);
  });

  it('returns errors (not throw) for a non-object input', () => {
    const result = parsePackageManifest('nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });
});
