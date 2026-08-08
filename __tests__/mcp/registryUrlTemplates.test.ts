/**
 * Launch-and-connect URL templating (#392).
 *
 * A registry package that runs locally but speaks HTTP templates its endpoint
 * against its own declarations. Resolving that template is only safe if the
 * result is verified to be loopback — see the security case below.
 */
import {
  argumentBindings,
  environmentBindings,
  resolveTransportUrl,
  runCommandLine
} from '@/utils/mcp/registry';

describe('argumentBindings', () => {
  it('preserves the name→value map that argumentsToTokens flattens away', () => {
    expect(
      argumentBindings([
        { type: 'named', name: '--port', value: '8088' },
        { type: 'named', name: '--host', default: '127.0.0.1' },
        { type: 'positional', value: 'serve' }
      ])
    ).toEqual({ '--port': '8088', '--host': '127.0.0.1' });
  });

  it('prefers an explicit value over the default', () => {
    expect(argumentBindings([{ type: 'named', name: '--port', value: '9000', default: '8088' }]))
      .toEqual({ '--port': '9000' });
  });

  it('omits named arguments with neither value nor default', () => {
    expect(argumentBindings([{ type: 'named', name: '--port' }])).toEqual({});
  });
});

describe('environmentBindings', () => {
  it('resolves value ?? default and skips empty declarations', () => {
    expect(
      environmentBindings([
        { name: 'API_PORT', default: '8088' },
        { name: 'API_HOST', value: 'localhost', default: '127.0.0.1' },
        { name: 'API_KEY', isRequired: true }
      ])
    ).toEqual({ API_PORT: '8088', API_HOST: 'localhost' });
  });
});

describe('resolveTransportUrl', () => {
  it('resolves {ENV_NAME} from environment-variable declarations', () => {
    expect(
      resolveTransportUrl('http://localhost:{DEVICESHELF_API_PORT}/mcp', {
        env: { DEVICESHELF_API_PORT: '8088' },
        args: {}
      })
    ).toEqual({ url: 'http://localhost:8088/mcp' });
  });

  it('resolves {--port} from named arguments', () => {
    expect(
      resolveTransportUrl('http://{--host}:{--port}/mcp', {
        env: {},
        args: { '--host': '127.0.0.1', '--port': '8088' }
      })
    ).toEqual({ url: 'http://127.0.0.1:8088/mcp' });
  });

  it('reports an unresolved placeholder instead of emitting a broken URL', () => {
    const result = resolveTransportUrl('http://localhost:{--port}/mcp', { env: {}, args: {} });
    expect(result).toEqual({ error: 'unresolved-placeholder', detail: '--port' });
  });

  it('reports an invalid URL', () => {
    const result = resolveTransportUrl('not a url', { env: {}, args: {} });
    expect('error' in result && result.error).toBe('invalid-url');
  });

  it('rejects a non-http protocol', () => {
    const result = resolveTransportUrl('ftp://localhost:8088/mcp', { env: {}, args: {} });
    expect('error' in result && result.error).toBe('invalid-url');
  });

  // The security regression test: registry publishers really do template this
  // field to public endpoints. Treating one as "trusted local" would point a
  // config the user believes is local at a third party.
  it('rejects a public host', () => {
    const result = resolveTransportUrl('https://mcp.crawlconsole.com/mcp', { env: {}, args: {} });
    expect(result).toEqual({ error: 'non-loopback', detail: 'mcp.crawlconsole.com' });
  });

  it('rejects a private-but-not-loopback host', () => {
    const result = resolveTransportUrl('http://192.168.1.10:8088/mcp', { env: {}, args: {} });
    expect('error' in result && result.error).toBe('non-loopback');
  });

  it.each([
    ['http://127.0.0.1:8088/mcp'],
    ['http://127.5.6.7:8088/mcp'],
    ['http://localhost:8088/mcp'],
    ['http://[::1]:8088/mcp']
  ])('accepts the loopback endpoint %s', (url) => {
    expect(resolveTransportUrl(url, { env: {}, args: {} })).toHaveProperty('url');
  });
});

describe('runCommandLine', () => {
  it('renders the exact command line, quoting tokens that need it', () => {
    expect(runCommandLine('docker', ['run', '-i', '--rm', 'example/mcp:1.0'])).toBe(
      'docker run -i --rm example/mcp:1.0'
    );
    expect(runCommandLine('npx', ['-y', '@example/mcp', '--name', 'my server'])).toBe(
      'npx -y @example/mcp --name "my server"'
    );
  });
});
