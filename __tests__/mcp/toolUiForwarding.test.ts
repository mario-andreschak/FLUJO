const loadServerConfigsMock = jest.fn();
const listServerToolsMock = jest.fn();

jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: (...args: unknown[]) => loadServerConfigsMock(...(args as [])),
    listServerTools: (...args: unknown[]) => listServerToolsMock(...(args as [])),
    isMcpAppAccessEnabled: async (serverName: string) => {
      const configs = await loadServerConfigsMock();
      return Array.isArray(configs)
        && configs.some((config: { name?: string; enableMcpApps?: boolean }) =>
          config.name === serverName && config.enableMcpApps === true);
    },
  },
}));

import { resolveInvokedToolUiLink } from '@/backend/mcpApps/toolUi';

describe('forwarded MCP App tool UI resolution', () => {
  beforeEach(() => {
    loadServerConfigsMock.mockReset();
    listServerToolsMock.mockReset();
  });

  it('uses the downstream definition and opt-in, never a result-only URI', async () => {
    loadServerConfigsMock.mockResolvedValue([
      {
        name: 'renamed-control',
        source: { type: 'marketplace', id: '@mario.andreschak/mcp-flujo' },
      },
      { name: 'cad', enableMcpApps: true },
    ]);
    listServerToolsMock.mockResolvedValue({
      tools: [{
        name: 'open_ui',
        _meta: { ui: { resourceUri: 'ui://cad/advertised' } },
      }],
    });

    await expect(resolveInvokedToolUiLink(
      'renamed-control',
      'call_mcp_tool',
      undefined,
      { _meta: { ui: { resourceUri: 'ui://cad/result-redirect' } } },
      { server: 'cad', tool: 'open_ui', args: { selected: 2 } },
    )).resolves.toEqual({
      uri: 'ui://cad/advertised',
      serverName: 'cad',
      toolName: 'open_ui',
      toolArgs: '{"selected":2}',
    });
    expect(listServerToolsMock).toHaveBeenCalledWith('cad', 'model');
  });

  it('does not let an arbitrary same-named wrapper select another server app', async () => {
    loadServerConfigsMock.mockResolvedValue([
      { name: 'lookalike', source: { type: 'local' } },
      { name: 'cad', enableMcpApps: true },
    ]);

    await expect(resolveInvokedToolUiLink(
      'lookalike',
      'call_mcp_tool',
      undefined,
      { _meta: { ui: { resourceUri: 'ui://cad/forged' } } },
      { server: 'cad', tool: 'open_ui', args: {} },
    )).resolves.toBeUndefined();
    expect(listServerToolsMock).not.toHaveBeenCalled();
  });
});
