/**
 * Unit tests for the package BUILD/EXPORT logic (issue #194) — the pure
 * halves of `buildPackage.ts` (no I/O). Covers dependency resolution, MCP
 * validation (local-only hard-abort), secret derivation and, critically, the
 * masking discipline: no plaintext model key or secret value ever reaches the
 * serialized manifest.
 */
import {
  buildManifestFromEntities,
  deriveMcpSecrets,
  deriveModelApiKeyRef,
  mapInstallOrigin,
  previewPackageSecrets,
  resolveDependencies,
  toSecretName,
  validateMcpSelection,
  type PackageEntities,
} from '@/backend/services/packages/buildPackage';
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import type { MCPServerConfig } from '@/shared/types/mcp';
import type { PlannedExecution } from '@/shared/types/plannedExecution';

// --- fixtures ---------------------------------------------------------------

function subflowNode(childFlowId: string): FlowNode {
  return {
    id: `n-sub-${childFlowId}`,
    type: 'subflow',
    position: { x: 0, y: 0 },
    data: { type: 'subflow', properties: { flowId: childFlowId } },
  } as unknown as FlowNode;
}

function processNode(modelId: string): FlowNode {
  return {
    id: `n-proc-${modelId}`,
    type: 'process',
    position: { x: 0, y: 0 },
    data: { type: 'process', properties: { modelId } },
  } as unknown as FlowNode;
}

function mcpNode(serverName: string): FlowNode {
  return {
    id: `n-mcp-${serverName}`,
    type: 'mcp',
    position: { x: 0, y: 0 },
    data: { type: 'mcp', properties: { mcpServer: serverName } },
  } as unknown as FlowNode;
}

function flow(id: string, name: string, nodes: FlowNode[] = []): Flow {
  return { id, name, nodes, edges: [] } as unknown as Flow;
}

function model(id: string, name: string, apiKey?: string): Model {
  return { id, name, displayName: name, provider: 'openai', ApiKey: apiKey } as unknown as Model;
}

function registryServer(name: string, env?: Record<string, unknown>): MCPServerConfig {
  return {
    name,
    transport: 'stdio',
    source: { type: 'registry', registryName: 'ai.example/thing' },
    env: env ?? {},
  } as unknown as MCPServerConfig;
}

function localServer(name: string): MCPServerConfig {
  return {
    name,
    transport: 'stdio',
    source: { type: 'local' },
    command: 'node',
    args: ['server.js'],
  } as unknown as MCPServerConfig;
}

function secretEnv(): Record<string, unknown> {
  return {
    API_TOKEN: { value: 'super-secret', metadata: { isSecret: true } },
    LOG_LEVEL: { value: 'info', metadata: { isSecret: false } },
  };
}

// --- resolveDependencies ----------------------------------------------------

describe('resolveDependencies', () => {
  const entities = (): PackageEntities => ({
    flows: [
      flow('root', 'Root', [subflowNode('child'), processNode('m1'), mcpNode('web')]),
      flow('child', 'Child', [processNode('m2')]),
    ],
    models: [model('m1', 'Model One'), model('m2', 'Model Two')],
    mcpServers: [registryServer('web')],
    plannedExecutions: [
      { id: 'pe1', name: 'Nightly', flowId: 'root', enabled: true } as unknown as PlannedExecution,
    ],
  });

  it('pulls in subflow descendants, referenced models and MCP servers', () => {
    const res = resolveDependencies({ flowIds: ['root'] }, entities());
    expect(res.flowIds.sort()).toEqual(['child', 'root']);
    expect(res.modelIds.sort()).toEqual(['m1', 'm2']);
    expect(res.mcpServerNames).toEqual(['web']);
    // Everything except the explicit root was auto-added.
    expect(res.autoAdded.some((a) => a.id === 'child')).toBe(true);
    expect(res.autoAdded.some((a) => a.id === 'm2')).toBe(true);
  });

  it('pulls in the flow a selected planned execution runs', () => {
    const res = resolveDependencies({ plannedExecutionIds: ['pe1'] }, entities());
    expect(res.flowIds).toContain('root');
    expect(res.autoAdded.some((a) => a.type === 'flow' && a.id === 'root')).toBe(true);
  });

  it('guards against circular subflow references', () => {
    const cyclic: PackageEntities = {
      flows: [flow('a', 'A', [subflowNode('b')]), flow('b', 'B', [subflowNode('a')])],
      models: [],
      mcpServers: [],
      plannedExecutions: [],
    };
    const res = resolveDependencies({ flowIds: ['a'] }, cyclic);
    expect(res.flowIds.sort()).toEqual(['a', 'b']);
  });

  it('records a warning for a missing referenced entity instead of throwing', () => {
    const partial: PackageEntities = {
      flows: [flow('root', 'Root', [subflowNode('ghost'), processNode('missing')])],
      models: [],
      mcpServers: [],
      plannedExecutions: [],
    };
    const res = resolveDependencies({ flowIds: ['root'] }, partial);
    expect(res.warnings.join(' ')).toMatch(/ghost/);
    expect(res.warnings.join(' ')).toMatch(/missing/);
  });
});

// --- validateMcpSelection + mapInstallOrigin --------------------------------

describe('validateMcpSelection', () => {
  it('hard-aborts a local-only server', () => {
    const { packaged, errors } = validateMcpSelection(['loc'], [localServer('loc')]);
    expect(packaged).toHaveLength(0);
    expect(errors.join(' ')).toMatch(/local server/i);
  });

  it('packages a non-local server by reference with env DECLARATIONS only', () => {
    const { packaged, errors } = validateMcpSelection(['web'], [registryServer('web', secretEnv())]);
    expect(errors).toHaveLength(0);
    expect(packaged).toHaveLength(1);
    const server = packaged[0];
    expect(server.installOrigin.sourceType).toBe('registry');
    // Declarations carry names + isSecret, never values.
    const serialized = JSON.stringify(server);
    expect(serialized).not.toContain('super-secret');
    const apiTokenDecl = server.envDeclarations.find((d) => d.name === 'API_TOKEN');
    expect(apiTokenDecl?.isSecret).toBe(true);
    const logDecl = server.envDeclarations.find((d) => d.name === 'LOG_LEVEL');
    expect(logDecl?.isSecret).toBe(false);
  });

  it('reports a missing server', () => {
    const { errors } = validateMcpSelection(['nope'], []);
    expect(errors.join(' ')).toMatch(/not found/i);
  });
});

describe('mapInstallOrigin', () => {
  it('maps a local source to null (unpackageable)', () => {
    expect(mapInstallOrigin(localServer('x'))).toBeNull();
  });
  it('maps a registry source to a registry install origin', () => {
    const origin = mapInstallOrigin(registryServer('x'));
    expect(origin).toMatchObject({ sourceType: 'registry', ref: 'ai.example/thing' });
  });
});

// --- secret derivation ------------------------------------------------------

describe('deriveModelApiKeyRef', () => {
  it('returns kind:none for a keyless model', () => {
    expect(deriveModelApiKeyRef(model('m', 'M')).ref).toEqual({ kind: 'none' });
  });

  it('binds a ${global:VAR} key to a global ref (no secret declared)', () => {
    const { ref, secret } = deriveModelApiKeyRef(model('m', 'M', '${global:OPENAI_KEY}'));
    expect(ref).toEqual({ kind: 'global', var: 'OPENAI_KEY' });
    expect(secret).toBeUndefined();
  });

  it('turns any real/masked key into a declared secret WITHOUT emitting the value', () => {
    const { ref, secret } = deriveModelApiKeyRef(model('m', 'My GPT', 'sk-plaintext-value'));
    expect(ref.kind).toBe('secret');
    expect(secret).toBeDefined();
    expect(JSON.stringify({ ref, secret })).not.toContain('sk-plaintext-value');
  });
});

describe('toSecretName', () => {
  it('produces a valid identifier', () => {
    expect(toSecretName('MODEL', 'My GPT!')).toMatch(/^[A-Z0-9_.-]+$/);
  });
});

describe('deriveMcpSecrets', () => {
  it('declares one secret per secret env declaration and binds a secretRef', () => {
    const { packaged } = validateMcpSelection(['web'], [registryServer('web', secretEnv())]);
    const secrets = deriveMcpSecrets(packaged);
    expect(secrets).toHaveLength(1);
    const decl = packaged[0].envDeclarations.find((d) => d.name === 'API_TOKEN');
    expect(decl?.secretRef).toBe(secrets[0].name);
  });
});

describe('previewPackageSecrets', () => {
  it('previews model + MCP secrets for a resolved selection', () => {
    const ents: PackageEntities = {
      flows: [flow('f', 'F', [processNode('m1'), mcpNode('web')])],
      models: [model('m1', 'Keyed', 'sk-abc')],
      mcpServers: [registryServer('web', secretEnv())],
      plannedExecutions: [],
    };
    const resolved = resolveDependencies({ flowIds: ['f'] }, ents);
    const secrets = previewPackageSecrets(resolved, ents);
    expect(secrets.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(secrets)).not.toContain('sk-abc');
    expect(JSON.stringify(secrets)).not.toContain('super-secret');
  });
});

// --- buildManifestFromEntities (masking integration) ------------------------

describe('buildManifestFromEntities', () => {
  const metadata = { id: 'pkg-1', name: 'Test Pkg', version: '1.0.0' };

  it('builds a valid manifest and NEVER leaks the model API key', () => {
    const ents: PackageEntities = {
      flows: [flow('f', 'F', [processNode('m1')])],
      models: [model('m1', 'Keyed', 'sk-SECRET-KEY-VALUE')],
      mcpServers: [],
      plannedExecutions: [],
    };
    const resolved = resolveDependencies({ flowIds: ['f'] }, ents);
    const result = buildManifestFromEntities(resolved, ents, metadata);

    expect(result.ok).toBe(true);
    expect(result.json).toBeDefined();
    // The plaintext key must not appear anywhere in the serialized package.
    expect(result.json).not.toContain('sk-SECRET-KEY-VALUE');
    // The packaged model carries an apiKeyRef, never the ApiKey field.
    const pkgModel = result.package!.models[0] as unknown as Record<string, unknown>;
    expect(pkgModel.ApiKey).toBeUndefined();
    expect((pkgModel.apiKeyRef as { kind: string }).kind).toBe('secret');
    // A matching secret is declared.
    expect(result.package!.secrets.some((s) => s.name === (pkgModel.apiKeyRef as { secret: string }).secret)).toBe(true);
  });

  it('fails the build when a local-only MCP server is included', () => {
    const ents: PackageEntities = {
      flows: [],
      models: [],
      mcpServers: [localServer('loc')],
      plannedExecutions: [],
    };
    const resolved = resolveDependencies({ mcpServerNames: ['loc'] }, ents);
    const result = buildManifestFromEntities(resolved, ents, metadata);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/local server/i);
  });
});
