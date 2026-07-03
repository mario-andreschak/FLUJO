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
  missingRequiredInputs
} from '@/utils/mcp/registry';
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
