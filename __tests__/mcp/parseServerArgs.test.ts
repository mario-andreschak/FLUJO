import { processPathLikeArgument } from '@/utils/mcp/processPathLikeArgument';
import { parseServerConfig } from '@/utils/mcp/parseServerConfig';

// Regression coverage for issue #40: parsing `npx -y @softeria/ms-365-mcp-server`
// produced args ["-y", "@softeria/", "--toon"] - the scoped package name was
// truncated at "/" because the server-name stripping in processPathLikeArgument
// matched the trailing "/ms-365-mcp-server" segment of the package spec.
describe('processPathLikeArgument (#40)', () => {
  it('leaves a scoped npm package whose name equals the server name intact', () => {
    expect(
      processPathLikeArgument('@softeria/ms-365-mcp-server', 'ms-365-mcp-server')
    ).toBe('@softeria/ms-365-mcp-server');
  });

  it('leaves a scoped npm package with a version suffix intact', () => {
    expect(
      processPathLikeArgument('@modelcontextprotocol/server-filesystem@1.2.3', 'server-filesystem')
    ).toBe('@modelcontextprotocol/server-filesystem@1.2.3');
  });

  it('leaves a scoped npm package intact when no server name is supplied', () => {
    expect(
      processPathLikeArgument('@scope/some-package')
    ).toBe('@scope/some-package');
  });

  it('still strips the server name from a genuine local path', () => {
    // The original intent of the helper: make a local path relative by removing
    // the server-name directory segment. This must keep working.
    expect(
      processPathLikeArgument('/Users/me/mcp-servers/myserver/dist/index.js', 'myserver')
    ).toBe('Users/me/mcp-servers/dist/index.js');
  });

  it('does not touch plain (unscoped) package names - they have no separator', () => {
    expect(processPathLikeArgument('ms-365-mcp-server', 'ms-365-mcp-server')).toBe('ms-365-mcp-server');
    expect(processPathLikeArgument('-y', 'ms-365-mcp-server')).toBe('-y');
    expect(processPathLikeArgument('--toon', 'ms-365-mcp-server')).toBe('--toon');
  });
});

describe('parseServerConfig args extraction (#40)', () => {
  it('preserves every arg of an npx/scoped-package command from a README JSON block', () => {
    const readme = [
      '# ms-365-mcp-server',
      '',
      '```json',
      '{',
      '  "mcpServers": {',
      '    "ms-365-mcp-server": {',
      '      "command": "npx",',
      '      "args": ["-y", "@softeria/ms-365-mcp-server", "--toon"]',
      '    }',
      '  }',
      '}',
      '```',
    ].join('\n');

    const { config } = parseServerConfig(readme, false, 'ms-365-mcp-server');
    const stdio = config as { command?: string; args?: string[] };

    expect(stdio.command).toBe('npx');
    expect(stdio.args).toEqual(['-y', '@softeria/ms-365-mcp-server', '--toon']);
  });
});
