/**
 * FlujoPackage manifest format v1 (issue #192) — schema + (de)serialization.
 *
 * Covers the security invariants the format exists to guarantee: no API keys,
 * no webhook tokens, no `encrypted:` blobs, declared-secret resolution,
 * package-internal reference resolution, and the size cap.
 */
import {
  MANIFEST_SIZE_CAP_BYTES,
  PACKAGE_SCHEMA_VERSION,
  serializePackage,
  parsePackage,
  validatePackage,
  collectFlowReferences,
  type FlujoPackage,
  type SerializePackageInput,
} from '@/shared/types/package';
import type { Model } from '@/shared/types/model/model';
import type { Flow } from '@/shared/types/flow/flow';
import type { PlannedExecution } from '@/shared/types/plannedExecution/plannedExecution';

const model: Model = {
  id: 'model-1',
  name: 'gpt-4o',
  displayName: 'GPT-4o',
  ApiKey: 'encrypted:DEADBEEF', // must be stripped, never serialized
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
};

const flowMain: Flow = {
  id: 'flow-main',
  name: 'Main',
  nodes: [
    {
      id: 'n1',
      position: { x: 0, y: 0 },
      data: { label: 'Sub', type: 'subflow', properties: { flowId: 'flow-sub' } },
    } as any,
    {
      id: 'n2',
      position: { x: 1, y: 1 },
      data: { label: 'MCP', type: 'mcp', properties: { mcpServer: 'web-search' } },
    } as any,
  ],
  edges: [],
};

const flowSub: Flow = { id: 'flow-sub', name: 'Sub', nodes: [], edges: [] };

const plannedWebhook: PlannedExecution = {
  id: 'pe-1',
  name: 'On webhook',
  enabled: false,
  flowId: 'flow-main',
  prompt: 'do the thing',
  trigger: { type: 'webhook', token: 'super-secret-token-123' },
  createdAt: '2026-07-20T00:00:00Z',
  updatedAt: '2026-07-20T00:00:00Z',
};

const baseInput: SerializePackageInput = {
  id: 'pkg-1',
  name: 'Demo Package',
  version: '1.2.3',
  secrets: [{ name: 'OPENAI_KEY', required: true }],
  models: [{ model, apiKeyRef: { kind: 'secret', secret: 'OPENAI_KEY' } }],
  mcpServers: [
    {
      name: 'web-search',
      transport: 'streamable',
      installOrigin: { sourceType: 'registry', ref: 'ai.keenable/web-search' },
      envDeclarations: [{ name: 'SEARCH_KEY', isSecret: true, secretRef: 'OPENAI_KEY' }],
    },
  ],
  flows: [flowMain, flowSub],
  plannedExecutions: [plannedWebhook],
};

describe('serializePackage / parsePackage round-trip', () => {
  it('serializes a minimal package and parses it back', () => {
    const { json, package: pkg } = serializePackage({
      id: 'min',
      name: 'Minimal',
      version: '0.1.0',
    });
    const parsed = parsePackage(json);
    expect(parsed.schemaVersion).toBe(PACKAGE_SCHEMA_VERSION);
    expect(parsed.id).toBe('min');
    expect(pkg.models).toEqual([]);
  });

  it('serializes a full package and parses it back', () => {
    const { json } = serializePackage(baseInput);
    const parsed = parsePackage(json);
    expect(parsed.name).toBe('Demo Package');
    expect(parsed.flows).toHaveLength(2);
    expect(parsed.mcpServers[0].installOrigin.sourceType).toBe('registry');
  });

  it('strips the model ApiKey and never emits an encrypted blob', () => {
    const { json, package: pkg } = serializePackage(baseInput);
    expect((pkg.models[0] as any).ApiKey).toBeUndefined();
    expect(pkg.models[0].apiKeyRef).toEqual({ kind: 'secret', secret: 'OPENAI_KEY' });
    expect(json).not.toContain('encrypted:');
    expect(json).not.toContain('DEADBEEF');
  });

  it('strips the webhook token from serialized output', () => {
    const { json, package: pkg } = serializePackage(baseInput);
    expect(json).not.toContain('super-secret-token-123');
    expect((pkg.plannedExecutions[0].trigger as any).token).toBeUndefined();
    // ...but preserves the source object (no mutation).
    expect(plannedWebhook.trigger).toEqual({ type: 'webhook', token: 'super-secret-token-123' });
  });

  it('records package-internal flow references for remapping', () => {
    const { package: pkg } = serializePackage(baseInput);
    const main = pkg.flows.find((f) => f.flow.id === 'flow-main')!;
    expect(main.references?.flowIds).toContain('flow-sub');
    expect(main.references?.mcpServerNames).toContain('web-search');
  });
});

describe('collectFlowReferences', () => {
  it('extracts subflow / mcp references from node properties', () => {
    const refs = collectFlowReferences(flowMain);
    expect(refs.flowIds).toEqual(['flow-sub']);
    expect(refs.mcpServerNames).toEqual(['web-search']);
  });
});

describe('security backstops', () => {
  it('rejects an encrypted: blob anywhere in the manifest', () => {
    const pkg: any = {
      schemaVersion: 1,
      id: 'x',
      name: 'x',
      version: '1.0.0',
      secrets: [],
      models: [],
      mcpServers: [],
      flows: [{ flow: { id: 'f', name: 'f', nodes: [{ note: 'encrypted:LEAK' }], edges: [] } }],
      plannedExecutions: [],
    };
    const res = validatePackage(pkg);
    expect(res.success).toBe(false);
    expect(res.errors!.join(' ')).toMatch(/encrypted:/);
  });

  it('rejects a leaked ApiKey field on a packaged model (strict object)', () => {
    const pkg: any = {
      schemaVersion: 1,
      id: 'x',
      name: 'x',
      version: '1.0.0',
      secrets: [],
      models: [{ id: 'm', name: 'm', apiKeyRef: { kind: 'none' }, ApiKey: 'plaintext' }],
      mcpServers: [],
      flows: [],
      plannedExecutions: [],
    };
    expect(validatePackage(pkg).success).toBe(false);
  });

  it('rejects a raw command/rootPath on an MCP server (by-reference only)', () => {
    const pkg: any = {
      schemaVersion: 1,
      id: 'x',
      name: 'x',
      version: '1.0.0',
      secrets: [],
      models: [],
      mcpServers: [
        {
          name: 's',
          transport: 'stdio',
          installOrigin: { sourceType: 'github', ref: 'o/r' },
          envDeclarations: [],
          command: 'node',
          rootPath: '/local/path',
        },
      ],
      flows: [],
      plannedExecutions: [],
    };
    expect(validatePackage(pkg).success).toBe(false);
  });
});

describe('reference resolution', () => {
  it('rejects an undeclared {{secret.NAME}} placeholder', () => {
    const input: SerializePackageInput = {
      id: 'p',
      name: 'p',
      version: '1.0.0',
      secrets: [],
      flows: [
        { id: 'f', name: 'f', nodes: [{ id: 'n', position: { x: 0, y: 0 }, data: { label: 'x', type: 'process', properties: { prompt: 'use {{secret.MISSING}}' } } } as any], edges: [] },
      ],
    };
    expect(() => serializePackage(input)).toThrow();
    const res = validatePackage({
      schemaVersion: 1, id: 'p', name: 'p', version: '1.0.0',
      secrets: [], models: [], mcpServers: [],
      flows: [{ flow: { id: 'f', name: 'f', nodes: [{ data: { properties: { p: 'use {{secret.MISSING}}' } } }], edges: [] } }],
      plannedExecutions: [],
    });
    expect(res.success).toBe(false);
    expect(res.errors!.join(' ')).toMatch(/MISSING/);
  });

  it('flags a declared-but-unused secret as a warning (not an error)', () => {
    const { json } = serializePackage({
      ...baseInput,
      secrets: [
        { name: 'OPENAI_KEY', required: true },
        { name: 'UNUSED_KEY', required: false },
      ],
    });
    const res = validatePackage(JSON.parse(json));
    expect(res.success).toBe(true);
    expect(res.warnings!.join(' ')).toMatch(/UNUSED_KEY/);
  });

  it('rejects a planned execution that references an unknown flow id', () => {
    const res = validatePackage({
      schemaVersion: 1, id: 'p', name: 'p', version: '1.0.0',
      secrets: [], models: [], mcpServers: [], flows: [],
      plannedExecutions: [{ id: 'pe', name: 'pe', enabled: false, flowId: 'ghost', prompt: '', trigger: { type: 'schedule', cron: '* * * * *' } }],
    });
    expect(res.success).toBe(false);
    expect(res.errors!.join(' ')).toMatch(/ghost/);
  });

  it('rejects a dangling subflow reference', () => {
    const res = validatePackage({
      schemaVersion: 1, id: 'p', name: 'p', version: '1.0.0',
      secrets: [], models: [], mcpServers: [],
      flows: [{ flow: { id: 'f', name: 'f', nodes: [], edges: [] }, references: { flowIds: ['nope'] } }],
      plannedExecutions: [],
    });
    expect(res.success).toBe(false);
    expect(res.errors!.join(' ')).toMatch(/nope/);
  });
});

describe('format validation', () => {
  it('enforces the size cap', () => {
    const big = 'x'.repeat(MANIFEST_SIZE_CAP_BYTES + 1);
    expect(() =>
      serializePackage({ id: 'p', name: 'p', version: '1.0.0', description: big }),
    ).toThrow(/size cap/);
    expect(() => parsePackage('{"padding":"' + big + '"}')).toThrow(/size cap/);
  });

  it('rejects an invalid semver version', () => {
    const res = validatePackage({
      schemaVersion: 1, id: 'p', name: 'p', version: 'not-semver',
      secrets: [], models: [], mcpServers: [], flows: [], plannedExecutions: [],
    });
    expect(res.success).toBe(false);
    expect(res.errors!.join(' ')).toMatch(/semver/);
  });

  it('rejects a wrong schemaVersion literal', () => {
    const res = validatePackage({
      schemaVersion: 2, id: 'p', name: 'p', version: '1.0.0',
      secrets: [], models: [], mcpServers: [], flows: [], plannedExecutions: [],
    });
    expect(res.success).toBe(false);
  });
});
