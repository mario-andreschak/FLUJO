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
    data: { type: 'mcp', properties: { boundServer: serverName } },
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

function registryHttpServer(
  name: string,
  headers: Record<string, unknown>,
): MCPServerConfig {
  return {
    name,
    transport: 'streamable',
    serverUrl: 'https://example.test/mcp',
    source: { type: 'registry', registryName: 'ai.example/http' },
    env: {},
    headers,
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

  it('infers legacy plain-string API keys and Authorization headers as secrets', () => {
    const envServer = registryServer('env-web', {
      API_KEY: 'legacy-plain-env-secret',
      PUBLIC_ORIGIN: 'https://example.test',
    });
    const headerServer = registryHttpServer('header-web', {
      Authorization: 'Bearer legacy-plain-header-secret',
      'X-Client': 'desktop',
    });

    const { packaged, errors } = validateMcpSelection(
      ['env-web', 'header-web'],
      [envServer, headerServer],
    );

    expect(errors).toEqual([]);
    expect(packaged[0].envDeclarations).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'API_KEY', isSecret: true }),
      expect.objectContaining({ name: 'PUBLIC_ORIGIN', isSecret: false }),
    ]));
    expect(packaged[1].headerDeclarations).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Authorization', isSecret: true }),
      expect.objectContaining({ name: 'X-Client', isSecret: false }),
    ]));
    // Config values are declarations only; neither plaintext value may leak.
    expect(JSON.stringify(packaged)).not.toContain('legacy-plain-env-secret');
    expect(JSON.stringify(packaged)).not.toContain('legacy-plain-header-secret');
  });

  it('honours explicit non-secret metadata even when the legacy key heuristic would match', () => {
    const { packaged } = validateMcpSelection(
      ['web'],
      [registryServer('web', {
        API_KEY: { value: 'intentionally-public', metadata: { isSecret: false } },
      })],
    );

    expect(packaged[0].envDeclarations).toContainEqual(
      expect.objectContaining({ name: 'API_KEY', isSecret: false }),
    );
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

  it('declares secrets for legacy plain-string env and header credentials', () => {
    const servers = [
      registryServer('env-web', { API_KEY: 'legacy-env-secret' }),
      registryHttpServer('header-web', { Authorization: 'legacy-header-secret' }),
    ];
    const { packaged } = validateMcpSelection(['env-web', 'header-web'], servers);
    const secrets = deriveMcpSecrets(packaged);

    expect(secrets).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'MCP_ENV-WEB_API_KEY' }),
      expect.objectContaining({ name: 'MCP_HEADER-WEB_AUTHORIZATION' }),
    ]));
  });

  it('does not create a second secret prompt for a secret global binding', () => {
    const { packaged } = validateMcpSelection(
      ['web'],
      [registryServer('web', {
        GITHUB_TOKEN: {
          value: '${global:GITHUB_TOKEN}',
          metadata: { isSecret: true },
        },
      })],
    );

    const secrets = deriveMcpSecrets(packaged);
    expect(secrets).toEqual([]);
    expect(packaged[0].envDeclarations).toContainEqual({
      name: 'GITHUB_TOKEN',
      isSecret: true,
      globalVar: 'GITHUB_TOKEN',
    });
  });
});

describe('previewPackageSecrets', () => {
  it('previews embedded placeholders + model + MCP secrets for a resolved selection', () => {
    const ents: PackageEntities = {
      flows: [
        flow('f', 'F', [
          processNode('m1'),
          mcpNode('web'),
          {
            id: 'prompt',
            type: 'process',
            position: { x: 0, y: 0 },
            data: {
              type: 'process',
              properties: { promptTemplate: 'Use {{secret.PATH_REPO}}' },
            },
          } as unknown as FlowNode,
        ]),
      ],
      models: [model('m1', 'Keyed', 'sk-abc')],
      mcpServers: [registryServer('web', secretEnv())],
      plannedExecutions: [],
    };
    const resolved = resolveDependencies({ flowIds: ['f'] }, ents);
    const secrets = previewPackageSecrets(resolved, ents);
    expect(secrets.length).toBeGreaterThanOrEqual(2);
    expect(secrets).toContainEqual(expect.objectContaining({ name: 'PATH_REPO', required: true }));
    expect(JSON.stringify(secrets)).not.toContain('sk-abc');
    expect(JSON.stringify(secrets)).not.toContain('super-secret');
  });

  it('previews a legacy plain-string credential on an MCP server bound by a flow', () => {
    const ents: PackageEntities = {
      flows: [flow('f', 'F', [mcpNode('github')])],
      models: [],
      mcpServers: [registryHttpServer('github', {
        Authorization: 'Bearer legacy-token',
      })],
      plannedExecutions: [],
    };
    const resolved = resolveDependencies({ flowIds: ['f'] }, ents);
    const secrets = previewPackageSecrets(resolved, ents);

    expect(resolved.mcpServerNames).toEqual(['github']);
    expect(secrets).toContainEqual(expect.objectContaining({
      name: 'MCP_GITHUB_AUTHORIZATION',
      required: true,
    }));
    expect(JSON.stringify(secrets)).not.toContain('legacy-token');
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

  it('preserves globals used in packaged flows and declares them as package globals', () => {
    const flowWithGlobals = flow('f', 'F', [
      {
        id: 'prompt',
        type: 'process',
        position: { x: 0, y: 0 },
        data: {
          type: 'process',
          properties: {
            promptTemplate: 'Use ${global:API_TOKEN} at ${global:API_BASE}; again ${global:API_TOKEN}',
          },
        },
      } as unknown as FlowNode,
    ]);
    const ents: PackageEntities = {
      flows: [flowWithGlobals],
      models: [],
      mcpServers: [],
      plannedExecutions: [],
    };

    const resolved = resolveDependencies({ flowIds: ['f'] }, ents);
    const result = buildManifestFromEntities(resolved, ents, metadata);

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.package!.secrets).toEqual([]);
    expect(result.package!.globals).toEqual([
      expect.objectContaining({ name: 'API_TOKEN', required: true }),
      expect.objectContaining({ name: 'API_BASE', required: true }),
    ]);
    expect(result.package!.requiredGlobals).toBeUndefined();
    expect(JSON.stringify(result.package!.flows)).toContain(
      'Use ${global:API_TOKEN} at ${global:API_BASE}; again ${global:API_TOKEN}',
    );
    expect(JSON.stringify(flowWithGlobals)).toContain('${global:API_TOKEN}');
  });

  it('re-declares placeholders when re-exporting installed flows and executions', () => {
    const flowWithPlaceholder = flow('f', 'F', [
      {
        id: 'prompt',
        type: 'process',
        position: { x: 0, y: 0 },
        data: {
          type: 'process',
          properties: { promptTemplate: 'Repository: {{secret.PATH_REPO}}' },
        },
      } as unknown as FlowNode,
    ]);
    const execution = {
      id: 'pe',
      name: 'AP implementation',
      flowId: 'f',
      enabled: false,
      prompt: 'Run in {{secret.PATH_REPO}}',
      trigger: { type: 'manual' },
    } as unknown as PlannedExecution;
    const ents: PackageEntities = {
      flows: [flowWithPlaceholder],
      models: [],
      mcpServers: [],
      plannedExecutions: [execution],
    };

    const resolved = resolveDependencies({ plannedExecutionIds: ['pe'] }, ents);
    const result = buildManifestFromEntities(
      resolved,
      ents,
      metadata,
      [],
      [],
      ['PATH_REPO'],
    );

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.package!.secrets).toEqual([
      expect.objectContaining({ name: 'PATH_REPO', required: true }),
    ]);
    expect(JSON.stringify(result.package!.flows)).toContain('{{secret.PATH_REPO}}');
    expect(JSON.stringify(result.package!.plannedExecutions)).toContain('{{secret.PATH_REPO}}');
  });

  it('records a global-var-bound model API key in requiredGlobals (not silently dropped)', () => {
    const ents: PackageEntities = {
      flows: [flow('f', 'F', [processNode('m1')])],
      models: [model('m1', 'GlobalKeyed', '${global:OPENAI_KEY}')],
      mcpServers: [],
      plannedExecutions: [],
    };
    const resolved = resolveDependencies({ flowIds: ['f'] }, ents);
    const result = buildManifestFromEntities(resolved, ents, metadata);

    expect(result.ok).toBe(true);
    expect(result.package!.requiredGlobals).toEqual(['OPENAI_KEY']);
    const pkgModel = result.package!.models[0] as unknown as Record<string, unknown>;
    expect(pkgModel.apiKeyRef).toEqual({ kind: 'global', var: 'OPENAI_KEY' });
  });

  it('records an MCP server env value literally bound to a global var in requiredGlobals', () => {
    const ents: PackageEntities = {
      flows: [],
      models: [],
      mcpServers: [registryServer('web', { API_BASE: '${global:MY_API_BASE}' })],
      plannedExecutions: [],
    };
    const resolved = resolveDependencies({ mcpServerNames: ['web'] }, ents);
    const result = buildManifestFromEntities(resolved, ents, metadata);

    expect(result.ok).toBe(true);
    expect(result.package!.requiredGlobals).toEqual(['MY_API_BASE']);
    const decl = result.package!.mcpServers[0].envDeclarations.find((d) => d.name === 'API_BASE');
    expect(decl?.globalVar).toBe('MY_API_BASE');
    expect(decl?.isSecret).toBe(false);
  });

  it('keeps a secret MCP global binding portable without adding an install secret', () => {
    const ents: PackageEntities = {
      flows: [],
      models: [],
      mcpServers: [registryHttpServer('github', {
        Authorization: {
          value: '${global:GITHUB_TOKEN}',
          metadata: { isSecret: true },
        },
      })],
      plannedExecutions: [],
    };
    const resolved = resolveDependencies({ mcpServerNames: ['github'] }, ents);
    const result = buildManifestFromEntities(resolved, ents, metadata);

    expect(result.ok).toBe(true);
    expect(result.package!.requiredGlobals).toEqual(['GITHUB_TOKEN']);
    expect(result.package!.secrets).toEqual([]);
    expect(result.package!.mcpServers[0].headerDeclarations).toContainEqual({
      name: 'Authorization',
      isSecret: true,
      globalVar: 'GITHUB_TOKEN',
    });
  });

  it('preserves an embedded secret-global header template and reviews the global as secret', () => {
    const ents: PackageEntities = {
      flows: [],
      models: [],
      mcpServers: [registryHttpServer('github', {
        Authorization: {
          value: 'Bearer ${global:softwaredev_github_api_key}',
          metadata: { isSecret: false },
        },
      })],
      plannedExecutions: [],
      globalVariables: {
        softwaredev_github_api_key: { isSecret: true },
      },
    };
    const resolved = resolveDependencies({ mcpServerNames: ['github'] }, ents);
    const result = buildManifestFromEntities(resolved, ents, metadata);

    expect(result.ok).toBe(true);
    expect(result.package!.requiredGlobals).toEqual(['softwaredev_github_api_key']);
    expect(result.package!.globals).toContainEqual(expect.objectContaining({
      name: 'softwaredev_github_api_key',
      required: true,
      isSecret: true,
    }));
    expect(result.package!.secrets).toEqual([]);
    expect(result.package!.mcpServers[0].headerDeclarations).toContainEqual({
      name: 'Authorization',
      isSecret: false,
      globalTemplate: 'Bearer ${global:softwaredev_github_api_key}',
    });
    expect(result.json).not.toContain('encrypted:');
  });

  it('preserves global templates embedded in MCP env values and stdio arguments', () => {
    const server = registryServer('templated', {
      API_ORIGIN: {
        value: 'https://${global:API_HOST}/v1',
        metadata: { isSecret: false },
      },
    });
    (server as MCPServerConfig & { args: string[] }).args = [
      '-y',
      '@example/server',
      '--token=${global:API_TOKEN}',
    ];
    const ents: PackageEntities = {
      flows: [],
      models: [],
      mcpServers: [server],
      plannedExecutions: [],
      globalVariables: {
        API_HOST: { isSecret: false },
        API_TOKEN: { isSecret: true },
      },
    };
    const resolved = resolveDependencies({ mcpServerNames: ['templated'] }, ents);
    const result = buildManifestFromEntities(resolved, ents, metadata);

    expect(result.ok).toBe(true);
    expect(result.package!.globals).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'API_HOST', isSecret: false }),
      expect.objectContaining({ name: 'API_TOKEN', isSecret: true }),
    ]));
    expect(result.package!.mcpServers[0].envDeclarations).toContainEqual({
      name: 'API_ORIGIN',
      isSecret: false,
      globalTemplate: 'https://${global:API_HOST}/v1',
    });
    expect(result.package!.mcpServers[0].argTemplates).toEqual([
      { index: 2, value: '--token=${global:API_TOKEN}' },
    ]);
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
