import { fireEvent, render, screen } from '@testing-library/react';
import ServerCard from '@/frontend/components/mcp/MCPServerManager/ServerCard';

jest.mock('@/frontend/services/mcp', () => ({ mcpService: { updateServerConfig: jest.fn() } }));
jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({ t: (key: string, values?: { name?: string }) => (values?.name ? `${key} ${values.name}` : key) }),
}));
jest.mock('@/frontend/utils/theme', () => ({ useThemeUtils: () => ({
  visualStyle: 'modern', getThemeColor: (color: string) => color,
}) }));
jest.mock('@/frontend/utils/workspaceSelection', () => ({
  getSelectedWorkspace: () => 'default-workspace', withWorkspaceUrl: (url: string) => url,
}));
jest.mock('@/frontend/components/shared/CopyLinkButton', () => () => null);
jest.mock('@/frontend/components/shared/FolderAssignMenu', () => () => null);
jest.mock('@/frontend/components/mcp/MCPServerManager/ServerLogo', () => () => null);
jest.mock('@/frontend/components/mcp/MCPServerManager/TransportBadge', () => () => null);
jest.mock('@/frontend/components/mcp/MCPServerManager/ServerUpdateDialog', () => () => null);

// A newcomer on the keyboard or with a screen reader must be able to open an app's tools,
// and every switch on the card must say what it turns on or off (#572).
describe('Connected Apps card for keyboard and screen-reader users', () => {
  it('opens the app through a real, named button and only once per press', () => {
    const onClick = jest.fn();
    render(<ServerCard name="filesystem" status="connected" path="" enabled transport="stdio" onClick={onClick} />);
    const open = screen.getByRole('button', { name: 'mcp.card.open filesystem' });
    expect(open.tagName).toBe('BUTTON');
    open.focus();
    expect(open).toHaveFocus();
    fireEvent.click(open);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('switch', { name: 'mcp.card.toggle filesystem' })).toBeChecked();
  });

  it('adds no inner button where the whole card is already the picker button', () => {
    render(<ServerCard name="filesystem" status="connected" path="" enabled transport="stdio" pickerMode onClick={jest.fn()} />);
    expect(screen.queryByRole('button', { name: 'mcp.card.open filesystem' })).not.toBeInTheDocument();
  });
});
