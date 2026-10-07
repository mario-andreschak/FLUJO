import { flattenCustomHeaders, resolveConfigHeaders, resolveStdioLaunch } from '@/backend/services/mcp/connection';
import { resolveAndDecryptApiKey } from '@/backend/utils/resolveGlobalVars';
import type { MCPStdioConfig, MCPStreamableConfig } from '@/shared/types/mcp';
import { installTrustedHostProfile } from './fixtures/trustedHostProfile';

jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: async (value: unknown) => value,
  resolveAndDecryptApiKey: jest.fn(async (value: string) => value),
}));

const common = { name: 'connection-data-fixture', env: {}, rootPath: '.', disabled: false,
  _buildCommand: '', _installCommand: '' };
const remote = (headers: Record<string, unknown>, env: Record<string, unknown> = {}): MCPStreamableConfig => ({
  ...common, transport: 'streamable', serverUrl: 'https://mcp.example.com/mcp',
  // Exercise the runtime configuration boundary, including malformed JSON value shapes.
  headers: headers as MCPStreamableConfig['headers'], env: env as MCPStreamableConfig['env'],
});
const resolver = resolveAndDecryptApiKey as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  resolver.mockImplementation(async (value: string) => value);
});

describe('MCP connection data admission', () => {
  it.each(['', 'X Invalid', 'X:Invalid', 'X\rInjected', 'X\nInjected', 'X\0Invalid', 'X-非ASCII', 'X\n', 'X\r', 'X\t'])(
    'drops an invalid header name before credential resolution: %j', async (name) => {
      const headers = Object.fromEntries([[name, { value: 'encrypted:SYNTHETIC', metadata: { isSecret: true } }]]);
      const result = await resolveConfigHeaders(remote(headers)) as MCPStreamableConfig;
      expect(Object.keys(result.headers ?? {})).toEqual([]);
      expect(resolver).not.toHaveBeenCalled();
      expect(Object.keys(headers)).toEqual([name]);
    },
  );

  it.each(['', 'BAD=NAME', 'BAD\0NAME'])('drops an invalid env name before credential resolution: %j', async (name) => {
    const env = Object.fromEntries([[name, { value: '${global:SYNTHETIC}' }]]);
    const result = await resolveConfigHeaders(remote({}, env));
    expect(Object.keys(result.env)).toEqual([]);
    expect(resolver).not.toHaveBeenCalled();
    expect(Object.keys(env)).toEqual([name]);
  });

  it('does not read inherited value getters or resolve non-string record values', async () => {
    const inheritedValue = jest.fn(() => 'encrypted:INHERITED_SYNTHETIC');
    const inherited = Object.create(Object.defineProperty({}, 'value', { get: inheritedValue }));
    const malformed = { inherited, number: { value: 42 }, object: { value: { token: 'SYNTHETIC' } } };
    const result = await resolveConfigHeaders(remote(malformed, malformed)) as MCPStreamableConfig;
    expect(Object.keys(result.headers ?? {})).toEqual([]);
    expect(Object.keys(result.env)).toEqual([]);
    expect(inheritedValue).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('preserves valid special names, HTTP token punctuation and own values as null-prototype data', async () => {
    const names = ['__proto__', 'constructor', 'prototype', 'toString', "X-!#$%&'*+.^_`|~"];
    const values = Object.fromEntries(names.map(name => [name, `SYNTHETIC-${name}`]));
    const headers = Object.fromEntries(names.map(name => [name, { value: values[name], metadata: { isSecret: true } }]));
    const result = await resolveConfigHeaders(remote(headers, values)) as MCPStreamableConfig;
    expect(JSON.parse(JSON.stringify(result.headers))).toEqual(values);
    expect(JSON.parse(JSON.stringify(result.env))).toEqual(values);
    expect(Object.getPrototypeOf(result.headers)).toBeNull();
    expect(Object.getPrototypeOf(result.env)).toBeNull();
    expect(Object.prototype).not.toHaveProperty('token');
    expect(resolver).toHaveBeenCalledTimes(names.length * 2);
  });

  it('keeps encrypted/global bindings portable and resolves only the temporary config', async () => {
    resolver.mockImplementation(async (value: string) => value.startsWith('encrypted:') ? 'SYNTHETIC-HEADER' : 'SYNTHETIC-ENV');
    const config = remote({ Authorization: { value: 'encrypted:SYNTHETIC', metadata: { isSecret: true } } },
      { TOKEN: { value: '${global:SYNTHETIC}', metadata: { isSecret: true } } });
    const before = JSON.stringify(config);
    const result = await resolveConfigHeaders(config) as MCPStreamableConfig;
    expect(result.headers).toEqual({ Authorization: 'SYNTHETIC-HEADER' });
    expect(result.env).toEqual({ TOKEN: 'SYNTHETIC-ENV' });
    expect(JSON.stringify(config)).toBe(before);
  });

  it('applies the same header admission when flattening without credential resolution', () => {
    const inheritedValue = jest.fn(() => 'SYNTHETIC-INHERITED');
    const headers = Object.fromEntries([
      ['X-Valid', { value: 'SYNTHETIC' }], ['__proto__', 'SYNTHETIC-OWN'],
      ['X Invalid', 'SYNTHETIC-BAD-NAME'], ['X-Inherited', Object.create({ get value() { return inheritedValue(); } })],
      ['X-Number', { value: 42 }],
    ]);
    const result = flattenCustomHeaders(headers);
    expect(JSON.parse(JSON.stringify(result))).toEqual({ 'X-Valid': 'SYNTHETIC', ['__proto__']: 'SYNTHETIC-OWN' });
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(inheritedValue).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('applies env admission to stdio launch construction without spawning a process', () => {
    const inheritedValue = jest.fn(() => 'SYNTHETIC-INHERITED');
    const approved = installTrustedHostProfile({ environment: Object.fromEntries([
      ['MODE', 'SYNTHETIC'], ['EMPTY', ''], ['__proto__', 'SYNTHETIC-OWN'],
    ]) });
    try {
    const result = resolveStdioLaunch(approved.config);
    expect(result.env.MODE).toBe('SYNTHETIC');
    expect(result.env.EMPTY).toBe('');
    expect(Object.getPrototypeOf(result.env)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(result.env, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result.env, '__proto__')?.value).toBe('SYNTHETIC-OWN');
    const malformed = [
      ['BAD=NAME', 'SYNTHETIC-BAD-NAME'], ['BAD\0NAME', 'SYNTHETIC-BAD-NAME'],
      ['INHERITED', Object.create({ get value() { return inheritedValue(); } })], ['NUMBER', { value: 42 }],
    ];
    for (const [name, value] of malformed) {
      const config: MCPStdioConfig = { ...approved.config,
        env: { ...approved.config.env, ...Object.fromEntries([[name, value]]) } };
      expect(() => approved.approve(config)).toThrow();
      expect(() => resolveStdioLaunch(config)).toThrow();
    }
    expect(inheritedValue).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    } finally { approved.restore(); }
  });
});
