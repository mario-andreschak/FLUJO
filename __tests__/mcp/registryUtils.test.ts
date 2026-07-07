/**
 * Tests for the MCP Registry → FLUJO config mapping layer
 * (src/utils/mcp/registry.ts), used by the ServerModal Marketplace tab.
 */
import {
  RegistryServer,
  getInstallOptions,
  buildConfigFromOption,
  sanitizeServerName,
  displayName,
  missingRequiredInputs,
  applySpotlightEnvDefaults,
  spotlightRequestPath,
  firstServerFromResponse
} from '@/utils/mcp/registry';
import { normalizeSpotlightSource } from '@/shared/config/spotlightServers';
import { MCPStdioConfig, MCPStreamableConfig, MCPSSEConfig } from '@/shared/types/mcp/mcp';

const baseServer = (overrides: Partial<RegistryServer>): RegistryServer => ({
  name: 'io.github.example/weather-mcp',
  description: 'Weather data for MCP',
  version: '1.2.3',
  ...overrides
});

describe('sanitizeServerName / displayName', () => {
  it('uses the segment after the namespace', () => {
    expect(sanitizeServerName('io.github.example/weather-mcp')).toBe('weather-mcp');
  });

  it('strips characters that are not safe for config keys or directories', () => {
    expect(sanitizeServerName('com.example/My Server (v2)!')).toBe('My-Server-v2');
  });

  it('falls back when nothing survives sanitizing', () => {
    expect(sanitizeServerName('com.example/***')).toBe('mcp-server');
  });

  it('prefers the title for display', () => {
    expect(displayName(baseServer({ title: 'Weather' }))).toBe('Weather');
    expect(displayName(baseServer({}))).toBe('weather-mcp');
  });

  // Many publishers name their server literally "mcp" (all Google Cloud
  // entries, com.notion/mcp, ...) — unqualified they would all collide.
  it('qualifies generic slugs like "mcp" with the last namespace segment', () => {
    expect(sanitizeServerName('com.googleapis.firestore/mcp')).toBe('firestore-mcp');
    expect(sanitizeServerName('com.notion/mcp')).toBe('notion-mcp');
    expect(sanitizeServerName('com.example/server')).toBe('example-server');
  });

  it('displays qualified names for generic slugs when there is no title', () => {
    expect(displayName(baseServer({ name: 'com.googleapis.firestore/mcp' }))).toBe('firestore-mcp');
    // Non-generic slugs stay untouched
    expect(displayName(baseServer({ name: 'io.github.example/weather-mcp' }))).toBe('weather-mcp');
  });
});

describe('getInstallOptions', () => {
  it('lists supported packages and remotes, packages first', () => {
    const server = baseServer({
      packages: [{ registryType: 'npm', identifier: '@example/weather-mcp', version: '1.2.3', transport: { type: 'stdio' } }],
      remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }]
    });
    const options = getInstallOptions(server);
    expect(options).toHaveLength(2);
    expect(options[0].kind).toBe('package');
    expect(options[1].kind).toBe('remote');
  });

  it('omits package types it cannot run (no runner, no runtimeHint)', () => {
    const server = baseServer({
      packages: [{ registryType: 'mcpb', identifier: 'https://example.com/server.mcpb' }]
    });
    expect(getInstallOptions(server)).toHaveLength(0);
  });

  it('keeps unknown package types when the publisher provides a runtimeHint', () => {
    const server = baseServer({
      packages: [{ registryType: 'cargo', identifier: 'weather-mcp', runtimeHint: 'cargo-mcp-run' }]
    });
    expect(getInstallOptions(server)).toHaveLength(1);
  });

  it('omits packages that expose an HTTP endpoint instead of stdio', () => {
    const server = baseServer({
      packages: [{
        registryType: 'npm',
        identifier: '@example/weather-mcp',
        transport: { type: 'streamable-http', url: 'http://localhost:{--port}/mcp' }
      }]
    });
    expect(getInstallOptions(server)).toHaveLength(0);
  });

  it('omits remotes with unknown transport types', () => {
    const server = baseServer({
      remotes: [{ type: 'websocket', url: 'wss://mcp.example.com' }]
    });
    expect(getInstallOptions(server)).toHaveLength(0);
  });
});

describe('buildConfigFromOption — npm packages', () => {
  const server = baseServer({
    packages: [{
      registryType: 'npm',
      identifier: '@example/weather-mcp',
      version: '1.2.3',
      transport: { type: 'stdio' },
      packageArguments: [
        { type: 'positional', value: 'serve' },
        { type: 'named', name: '--region', default: 'eu' },
        { type: 'named', name: '--verbose' }, // optional, no value → omitted
        { type: 'positional', isRequired: true, valueHint: 'data_dir' } // required, unknown → placeholder
      ],
      environmentVariables: [
        { name: 'WEATHER_API_KEY', isRequired: true, isSecret: true },
        { name: 'WEATHER_UNITS', default: 'metric' }
      ]
    }]
  });

  it('builds an npx stdio config with args, placeholders and env', () => {
    const config = buildConfigFromOption(server, getInstallOptions(server)[0]) as Partial<MCPStdioConfig>;
    expect(config.transport).toBe('stdio');
    expect(config.name).toBe('weather-mcp');
    expect(config.command).toBe('npx');
    expect(config.args).toEqual([
      '-y',
      '@example/weather-mcp@1.2.3',
      'serve',
      '--region', 'eu',
      '<data_dir>'
    ]);
    expect(config.env).toEqual({
      WEATHER_API_KEY: { value: '', metadata: { isSecret: true } },
      WEATHER_UNITS: 'metric'
    });
    expect(config.rootPath).toBe('.');
  });

  it('reports required env vars that still need a value', () => {
    const option = getInstallOptions(server)[0];
    expect(missingRequiredInputs(option)).toEqual(['WEATHER_API_KEY']);
  });

  it('respects a runtimeHint override', () => {
    const hinted = baseServer({
      packages: [{ registryType: 'npm', identifier: 'weather-mcp', runtimeHint: 'bunx' }]
    });
    const config = buildConfigFromOption(hinted, getInstallOptions(hinted)[0]) as Partial<MCPStdioConfig>;
    expect(config.command).toBe('bunx');
    expect(config.args).toEqual(['-y', 'weather-mcp']);
  });
});

describe('buildConfigFromOption — pypi packages', () => {
  it('uses uvx with a == version specifier', () => {
    const server = baseServer({
      packages: [{ registryType: 'pypi', identifier: 'weather-mcp', version: '2.0.1' }]
    });
    const config = buildConfigFromOption(server, getInstallOptions(server)[0]) as Partial<MCPStdioConfig>;
    expect(config.command).toBe('uvx');
    expect(config.args).toEqual(['weather-mcp==2.0.1']);
  });
});

describe('buildConfigFromOption — oci packages', () => {
  it('builds a docker run command with env passthrough flags', () => {
    const server = baseServer({
      packages: [{
        registryType: 'oci',
        identifier: 'docker.io/example/weather-mcp',
        version: '1.2.3',
        environmentVariables: [{ name: 'WEATHER_API_KEY', isRequired: true, isSecret: true }]
      }]
    });
    const config = buildConfigFromOption(server, getInstallOptions(server)[0]) as Partial<MCPStdioConfig>;
    expect(config.command).toBe('docker');
    expect(config.args).toEqual([
      'run', '-i', '--rm',
      '-e', 'WEATHER_API_KEY',
      'docker.io/example/weather-mcp:1.2.3'
    ]);
    expect(config.env).toEqual({
      WEATHER_API_KEY: { value: '', metadata: { isSecret: true } }
    });
  });

  it('does not double-tag an identifier that already carries a tag', () => {
    const server = baseServer({
      packages: [{ registryType: 'oci', identifier: 'example/weather-mcp:latest', version: '1.2.3' }]
    });
    const config = buildConfigFromOption(server, getInstallOptions(server)[0]) as Partial<MCPStdioConfig>;
    expect(config.args).toContain('example/weather-mcp:latest');
    expect(config.args).not.toContain('example/weather-mcp:latest:1.2.3');
  });

  it('keeps runtime arguments and inserts them after docker run flags', () => {
    const server = baseServer({
      packages: [{
        registryType: 'oci',
        identifier: 'example/weather-mcp',
        runtimeArguments: [{ type: 'named', name: '--network', value: 'host' }]
      }]
    });
    const config = buildConfigFromOption(server, getInstallOptions(server)[0]) as Partial<MCPStdioConfig>;
    expect(config.args).toEqual(['run', '-i', '--rm', '--network', 'host', 'example/weather-mcp']);
  });
});

describe('buildConfigFromOption — remotes', () => {
  it('maps streamable-http to the streamable transport with headers', () => {
    const server = baseServer({
      remotes: [{
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        headers: [
          { name: 'Authorization', value: 'Bearer {api_key}', isRequired: true, isSecret: true },
          { name: 'X-Region', default: 'eu' }
        ]
      }]
    });
    const option = getInstallOptions(server)[0];
    const config = buildConfigFromOption(server, option) as Partial<MCPStreamableConfig>;
    expect(config.transport).toBe('streamable');
    expect(config.serverUrl).toBe('https://mcp.example.com/mcp');
    expect(config.headers).toEqual({
      Authorization: 'Bearer {api_key}',
      'X-Region': 'eu'
    });
    // The Authorization template counts as provided; nothing is "missing"
    expect(missingRequiredInputs(option)).toEqual([]);
  });

  it('maps sse remotes to the sse transport', () => {
    const server = baseServer({
      remotes: [{ type: 'sse', url: 'https://mcp.example.com/sse' }]
    });
    const config = buildConfigFromOption(server, getInstallOptions(server)[0]) as Partial<MCPSSEConfig>;
    expect(config.transport).toBe('sse');
    expect(config.serverUrl).toBe('https://mcp.example.com/sse');
  });

  it('lists required headers without any value as missing', () => {
    const server = baseServer({
      remotes: [{
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        headers: [{ name: 'X-API-Key', isRequired: true, isSecret: true }]
      }]
    });
    expect(missingRequiredInputs(getInstallOptions(server)[0])).toEqual(['X-API-Key']);
  });
});

describe('spotlightRequestPath', () => {
  it('turns a search-form URL into a single-result registry query', () => {
    expect(
      spotlightRequestPath('https://registry.modelcontextprotocol.io/?q=ai.keenable%2Fweb-search')
    ).toBe('/v0.1/servers?search=ai.keenable%2Fweb-search&version=latest&limit=1');
  });

  it('passes an exact server-version URL through verbatim', () => {
    expect(
      spotlightRequestPath(
        'https://registry.modelcontextprotocol.io/v0.1/servers/ai.keenable%2Fweb-search/versions/0.1.2'
      )
    ).toBe('/v0.1/servers/ai.keenable%2Fweb-search/versions/0.1.2');
  });

  it('resolves a server URL without a version via search', () => {
    expect(
      spotlightRequestPath('https://registry.modelcontextprotocol.io/v0.1/servers/ai.keenable%2Fweb-search')
    ).toBe('/v0.1/servers?search=ai.keenable%2Fweb-search&version=latest&limit=1');
  });

  // Issue #55: the registry's versions-list form (no version specified) must
  // resolve to the latest version instead of "Unrecognized spotlight URL format".
  it('resolves a version-less /versions URL via search (latest version)', () => {
    expect(
      spotlightRequestPath(
        'https://registry.modelcontextprotocol.io/v0.1/servers/io.github.mario-andreschak%2Fmcp-abap-adt/versions'
      )
    ).toBe('/v0.1/servers?search=io.github.mario-andreschak%2Fmcp-abap-adt&version=latest&limit=1');
  });

  it('tolerates a trailing slash on the version-less /versions form', () => {
    expect(
      spotlightRequestPath(
        'https://registry.modelcontextprotocol.io/v0.1/servers/ai.keenable%2Fweb-search/versions/'
      )
    ).toBe('/v0.1/servers?search=ai.keenable%2Fweb-search&version=latest&limit=1');
  });

  // Guards the regex-ordering invariant: the exact-version check runs before the
  // version-less one, so an explicit version still passes through verbatim.
  it('still passes an exact server-version URL through verbatim after the /versions change', () => {
    expect(
      spotlightRequestPath(
        'https://registry.modelcontextprotocol.io/v0.1/servers/ai.keenable%2Fweb-search/versions/1.2.3'
      )
    ).toBe('/v0.1/servers/ai.keenable%2Fweb-search/versions/1.2.3');
  });

  it('rejects URLs it does not understand', () => {
    expect(spotlightRequestPath('https://registry.modelcontextprotocol.io/')).toBeNull();
    expect(spotlightRequestPath('not a url')).toBeNull();
    // Extra segments after an exact version are still unrecognized.
    expect(
      spotlightRequestPath(
        'https://registry.modelcontextprotocol.io/v0.1/servers/ai.keenable%2Fweb-search/versions/1.2.3/extra'
      )
    ).toBeNull();
  });
});

// Issue #60: curated spotlight entries can ship default env vars that are
// merged into the generated config at install time.
describe('applySpotlightEnvDefaults', () => {
  it('adds env vars the registry record did not declare', () => {
    const config = { env: { EXISTING: 'kept' } } as Partial<MCPStdioConfig>;
    const merged = applySpotlightEnvDefaults(config, { PLAYWRIGHT_MCP_BROWSER: 'msedge' });
    expect(merged.env).toEqual({
      EXISTING: 'kept',
      PLAYWRIGHT_MCP_BROWSER: 'msedge'
    });
    // The input config is not mutated
    expect(config.env).toEqual({ EXISTING: 'kept' });
  });

  it('replaces the default value of declared plain env vars', () => {
    const config = { env: { UNITS: 'metric' } } as Partial<MCPStdioConfig>;
    const merged = applySpotlightEnvDefaults(config, { UNITS: 'imperial' });
    expect(merged.env).toEqual({ UNITS: 'imperial' });
  });

  it('preserves the secret shape when the registry declared the var as secret', () => {
    const config = {
      env: { TOKEN: { value: '', metadata: { isSecret: true } } }
    } as unknown as Partial<MCPStdioConfig>;
    const merged = applySpotlightEnvDefaults(config, { TOKEN: 'default-token' });
    expect(merged.env).toEqual({
      TOKEN: { value: 'default-token', metadata: { isSecret: true } }
    });
  });

  it('is a no-op when there are no overrides', () => {
    const config = { env: { A: '1' } } as Partial<MCPStdioConfig>;
    expect(applySpotlightEnvDefaults(config, undefined)).toBe(config);
    expect(applySpotlightEnvDefaults(config, {})).toBe(config);
  });

  it('creates the env record when the config has none', () => {
    const merged = applySpotlightEnvDefaults({}, { A: '1' });
    expect(merged.env).toEqual({ A: '1' });
  });
});

describe('missingRequiredInputs with spotlight env overrides', () => {
  const server = baseServer({
    packages: [{
      registryType: 'npm',
      identifier: '@example/weather-mcp',
      environmentVariables: [
        { name: 'WEATHER_API_KEY', isRequired: true, isSecret: true },
        { name: 'WEATHER_REGION', isRequired: true }
      ]
    }]
  });

  it('counts a curated default as satisfying a required env var', () => {
    const option = getInstallOptions(server)[0];
    expect(missingRequiredInputs(option, { WEATHER_REGION: 'eu' })).toEqual(['WEATHER_API_KEY']);
    expect(
      missingRequiredInputs(option, { WEATHER_REGION: 'eu', WEATHER_API_KEY: 'k' })
    ).toEqual([]);
  });

  it('changes nothing when no overrides are given', () => {
    const option = getInstallOptions(server)[0];
    expect(missingRequiredInputs(option)).toEqual(['WEATHER_API_KEY', 'WEATHER_REGION']);
  });
});

describe('normalizeSpotlightSource', () => {
  it('wraps bare-string entries into { url }', () => {
    expect(normalizeSpotlightSource('https://example.com/x')).toEqual({ url: 'https://example.com/x' });
  });

  it('passes object entries through unchanged', () => {
    const source = { url: 'https://example.com/x', env: { A: '1' } };
    expect(normalizeSpotlightSource(source)).toBe(source);
  });
});

describe('firstServerFromResponse', () => {
  const server = { name: 'ai.keenable/web-search', version: '0.1.2' };

  it('takes the first entry of a list response', () => {
    expect(firstServerFromResponse({ servers: [{ server }], metadata: { count: 1 } })).toEqual({ server });
  });

  it('accepts the single-server response shape', () => {
    expect(firstServerFromResponse({ server, _meta: {} })).toEqual({ server, _meta: {} });
  });

  it('returns null when nothing matched', () => {
    expect(firstServerFromResponse({ servers: [] })).toBeNull();
    expect(firstServerFromResponse(null)).toBeNull();
    expect(firstServerFromResponse({})).toBeNull();
  });
});
