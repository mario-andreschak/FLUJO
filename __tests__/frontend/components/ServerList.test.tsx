import { render, screen } from '@testing-library/react';
import React from 'react';
import type { MCPServerState } from '@/shared/types/mcp';

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

jest.mock('@/frontend/components/mcp/MCPServerManager/ServerCard', () => ({
  __esModule: true,
  default: ({ name }: { name: string }) => <div data-testid="server-card">{name}</div>,
}));

import ServerList from '@/frontend/components/mcp/MCPServerManager/ServerList';

const makeServer = (name: string): MCPServerState =>
  ({
    name,
    transport: 'stdio',
    status: 'connected',
    rootPath: `C:/servers/${name}`,
    disabled: false,
    command: 'node',
    args: [],
    env: {},
  }) as unknown as MCPServerState;

const noop = () => {};

const renderList = (servers: MCPServerState[]) =>
  render(
    <ServerList
      servers={servers}
      isLoading={false}
      loadError={null}
      onServerSelect={noop}
      onServerToggle={noop}
      onServerRetry={noop}
      onServerDelete={noop}
      onServerEdit={noop}
    />,
  );

describe('ServerList responsive layout (#410)', () => {
  it('renders exactly one card per server', () => {
    renderList([makeServer('alpha'), makeServer('beta'), makeServer('gamma')]);

    const cards = screen.getAllByTestId('server-card');
    expect(cards).toHaveLength(3);
    expect(cards.map((card) => card.textContent)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('keeps cards full width on small screens and half of the previous width on md/lg', () => {
    const { container } = renderList([makeServer('alpha'), makeServer('beta')]);

    const items = Array.from(container.querySelectorAll('.MuiGrid-item'));
    expect(items).toHaveLength(2);

    items.forEach((item) => {
      // xs stays full width: one readable column on phones/narrow windows.
      expect(item).toHaveClass('MuiGrid-grid-xs-12');
      // md halves from 6 (50%) to 3 (25%).
      expect(item).toHaveClass('MuiGrid-grid-md-3');
      expect(item).not.toHaveClass('MuiGrid-grid-md-6');
      // lg halves from 4 (33.3%) to 2 (16.7%).
      expect(item).toHaveClass('MuiGrid-grid-lg-2');
      expect(item).not.toHaveClass('MuiGrid-grid-lg-4');
    });
  });

  it('still renders the empty state when there are no servers', () => {
    renderList([]);

    expect(screen.queryAllByTestId('server-card')).toHaveLength(0);
    expect(screen.getByText('mcp.list.empty')).toBeInTheDocument();
  });
});
