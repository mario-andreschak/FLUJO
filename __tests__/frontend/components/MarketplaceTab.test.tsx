import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import MarketplaceTab from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/MarketplaceTab';

const registryResponse = {
  success: true,
  servers: [
    {
      server: {
        name: 'io.example/local',
        title: 'Local tools',
        packages: [{ registryType: 'npm', identifier: '@example/local' }],
      },
      _meta: {
        'io.modelcontextprotocol.registry/official': { status: 'active' },
      },
      quality: { score: 0.8, status: 'active', stars: 12 },
    },
    {
      server: {
        name: 'io.example/remote',
        title: 'Remote tools',
        remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }],
      },
      _meta: {
        'io.modelcontextprotocol.registry/official': { status: 'unverified' },
      },
      quality: { score: 0.4, status: 'unverified' },
    },
  ],
  metadata: {},
};

describe('MarketplaceTab search controls', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => registryResponse,
    }) as jest.Mock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('submits an explicit search and refines the loaded results', async () => {
    render(<MarketplaceTab onAdd={jest.fn()} onClose={jest.fn()} />);

    const searchInput = screen.getByRole('textbox', { name: 'Search MCP servers' });
    const searchButton = screen.getByRole('button', { name: 'Search' });
    expect(searchButton).toBeDisabled();
    expect(screen.getAllByRole('combobox')).toHaveLength(4);

    fireEvent.change(searchInput, { target: { value: 'github' } });
    fireEvent.click(searchButton);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      '/api/mcp-registry?limit=30&search=github',
    ));
    expect(await screen.findByText('Showing 2 of 2 loaded servers')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Verification' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Verified' }));

    expect(await screen.findByText('Showing 1 of 2 loaded servers')).toBeInTheDocument();
    expect(screen.getByText('Local tools')).toBeInTheDocument();
    expect(screen.queryByText('Remote tools')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeEnabled();
  });
});
