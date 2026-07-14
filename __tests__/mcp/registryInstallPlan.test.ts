/**
 * Unit tests for the SEP-1024 resolve-only plan builder (issue #98): the pure
 * layer that turns a registry entry + install option into the exact command +
 * args + required env NAMES that WOULD be spawned, without spawning.
 */
import {
  RegistryServer,
  RegistryServerResult,
  getInstallOptions,
  resolvedPlanFrom,
  requiredInputNames,
  verificationStatusOf,
  isVerifiedStatus,
} from '@/utils/mcp/registry';

function planFor(server: RegistryServer, status = 'unverified') {
  const option = getInstallOptions(server)[0];
  expect(option).toBeDefined();
  return resolvedPlanFrom(server.name, server, option, status);
}

describe('resolvedPlanFrom — npm', () => {
  const server: RegistryServer = {
    name: 'ai.example/web-search',
    packages: [
      {
        registryType: 'npm',
        identifier: '@example/web-search',
        version: '1.2.3',
        environmentVariables: [
          { name: 'SEARCH_API_KEY', isRequired: true, isSecret: true },
          { name: 'OPTIONAL_FLAG' },
        ],
      },
    ],
  };

  it('resolves npx -y <pkg@version> and lists only the required env NAME', () => {
    const plan = planFor(server);
    expect(plan.transport).toBe('stdio');
    expect(plan.command).toBe('npx');
    expect(plan.args).toEqual(['-y', '@example/web-search@1.2.3']);
    expect(plan.serverName).toBe('web-search');
    expect(plan.resolvedName).toBe('ai.example/web-search');
    expect(plan.requiredEnvNames).toEqual(['SEARCH_API_KEY']);
  });
});

describe('resolvedPlanFrom — pypi', () => {
  const server: RegistryServer = {
    name: 'io.example/py-tool',
    packages: [{ registryType: 'pypi', identifier: 'py-tool', version: '0.4.0' }],
  };

  it('resolves uvx <pkg==version>', () => {
    const plan = planFor(server);
    expect(plan.command).toBe('uvx');
    expect(plan.args).toEqual(['py-tool==0.4.0']);
    expect(plan.requiredEnvNames).toEqual([]);
  });
});

describe('resolvedPlanFrom — oci (docker)', () => {
  const server: RegistryServer = {
    name: 'com.example/docker-tool',
    packages: [
      {
        registryType: 'oci',
        identifier: 'example/docker-tool',
        version: '2.0.0',
        environmentVariables: [{ name: 'TOKEN', isRequired: true, isSecret: true }],
      },
    ],
  };

  it('resolves docker run -i --rm -e TOKEN <image:version> and passes env by NAME only', () => {
    const plan = planFor(server);
    expect(plan.command).toBe('docker');
    expect(plan.args).toEqual(['run', '-i', '--rm', '-e', 'TOKEN', 'example/docker-tool:2.0.0']);
    // The docker args reference TOKEN by name only — never a value.
    expect(plan.args?.join(' ')).not.toContain('secret');
    expect(plan.requiredEnvNames).toEqual(['TOKEN']);
  });
});

describe('resolvedPlanFrom — remote', () => {
  const server: RegistryServer = {
    name: 'com.example/remote',
    remotes: [
      {
        type: 'streamable-http',
        url: 'https://mcp.example.com/v1',
        headers: [{ name: 'Authorization', isRequired: true }],
      },
    ],
  };

  it('resolves a remote transport + serverUrl with no command', () => {
    const plan = planFor(server);
    expect(plan.transport).toBe('streamable');
    expect(plan.serverUrl).toBe('https://mcp.example.com/v1');
    expect(plan.command).toBeUndefined();
    expect(plan.requiredEnvNames).toEqual(['Authorization']);
  });
});

describe('requiredInputNames', () => {
  it('returns required env names even when they carry a default value', () => {
    const server: RegistryServer = {
      name: 'x/y',
      packages: [
        {
          registryType: 'npm',
          identifier: 'y',
          environmentVariables: [
            { name: 'REQ_WITH_DEFAULT', isRequired: true, default: 'd' },
            { name: 'OPT' },
          ],
        },
      ],
    };
    expect(requiredInputNames(getInstallOptions(server)[0])).toEqual(['REQ_WITH_DEFAULT']);
  });
});

describe('verificationStatusOf / isVerifiedStatus', () => {
  it('defaults to "unverified" when _meta status is absent', () => {
    const result: RegistryServerResult = { server: { name: 'x/y' } };
    expect(verificationStatusOf(result)).toBe('unverified');
    expect(isVerifiedStatus(verificationStatusOf(result))).toBe(false);
  });

  it('reads the registry status and treats only "active" as verified', () => {
    const active: RegistryServerResult = {
      server: { name: 'x/y' },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
    };
    const deprecated: RegistryServerResult = {
      server: { name: 'x/y' },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deprecated' } },
    };
    expect(verificationStatusOf(active)).toBe('active');
    expect(isVerifiedStatus('active')).toBe(true);
    expect(isVerifiedStatus(verificationStatusOf(deprecated))).toBe(false);
    expect(isVerifiedStatus(undefined)).toBe(false);
  });
});
