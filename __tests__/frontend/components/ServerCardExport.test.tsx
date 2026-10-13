import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ServerCard from '@/frontend/components/mcp/MCPServerManager/ServerCard';
import type { MCPServerConfig } from '@/shared/types/mcp';

const updateServerConfig = jest.fn();
jest.mock('@/frontend/services/mcp', () => ({ mcpService: {
  updateServerConfig: (...args: unknown[]) => updateServerConfig(...args),
} }));
jest.mock('@/frontend/contexts/I18nContext', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('@/frontend/utils/theme', () => ({ useThemeUtils: () => ({
  visualStyle: 'modern', getThemeColor: (color: string) => color,
}) }));
jest.mock('@/frontend/utils/workspaceSelection', () => ({
  getSelectedWorkspace: () => 'team-a', withWorkspaceUrl: (url: string) => `${url}?workspace=team-a`,
}));
jest.mock('@/frontend/components/shared/CopyLinkButton', () => () => null);
jest.mock('@/frontend/components/shared/FolderAssignMenu', () => () => null);
jest.mock('@/frontend/components/mcp/MCPServerManager/ServerLogo', () => () => null);
jest.mock('@/frontend/components/mcp/MCPServerManager/TransportBadge', () => () => null);
jest.mock('@/frontend/components/mcp/MCPServerManager/ServerUpdateDialog', () => () => null);

describe('ServerCard exposed connection clipboard', () => {
  const writeText = jest.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });

  it.each(['sse', 'streamable', 'stdio', 'websocket'] as const)(
    'copies only the workspace proxy immediately after exposing %s, before parent config refresh',
    async transport => {
      let resolveUpdate!: (result: { success: boolean }) => void;
      updateServerConfig.mockReturnValue(new Promise(resolve => { resolveUpdate = resolve; }));
      const config = {
        name: 'saved connection', transport, exposeAsMcpServer: false,
        serverUrl: 'https://upstream.example.test/mcp', websocketUrl: 'wss://upstream.example.test/mcp',
        command: 'private-launcher', args: ['private-launch-argument'],
        env: { PRIVATE_SETTING: 'fixture-private-env' }, headers: { Authorization: 'fixture-private-header' },
        disabled: false, rootPath: '', _buildCommand: '', _installCommand: '',
      } as MCPServerConfig;
      render(<ServerCard name={config.name} status="connected" path="" enabled transport={transport}
        exposeAsMcpServer={false} serverConfig={config} onClick={() => undefined} />);
      fireEvent.click(screen.getByRole('switch', { name: 'mcp.card.expose' }));
      await act(async () => { resolveUpdate({ success: true }); });
      await waitFor(() => expect(screen.getByRole('button', { name: 'mcp.card.copyJson' })).toBeVisible());
      // Successful persistence does not mutate the old props; the card is
      // usable before the parent's periodic configuration reload completes.
      expect(config.exposeAsMcpServer).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'mcp.card.copyJson' }));
      expect(JSON.parse(writeText.mock.calls.at(-1)![0])).toEqual({ mcpServers: {
        'saved connection': { type: 'http', url: 'http://localhost/mcp-proxy/saved%20connection?workspace=team-a' },
      } });
    },
  );

  it('removes the clipboard actions when exposure persistence fails', async () => {
    let rejectExposure!: (result: { success: boolean; error: string }) => void;
    updateServerConfig.mockReturnValue(new Promise(resolve => { rejectExposure = resolve; }));
    render(<ServerCard name="saved connection" status="connected" path="" enabled transport="sse"
      exposeAsMcpServer={false} onClick={() => undefined} />);
    fireEvent.click(screen.getByRole('switch', { name: 'mcp.card.expose' }));
    await act(async () => { rejectExposure({ success: false, error: 'Fixture save refusal' }); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'mcp.card.copyJson' })).not.toBeInTheDocument());
    expect(screen.getByRole('switch', { name: 'mcp.card.expose' })).not.toBeChecked();
    expect(writeText).not.toHaveBeenCalled();
  });
});
