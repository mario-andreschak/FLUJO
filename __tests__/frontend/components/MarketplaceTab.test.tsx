import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import MarketplaceTab from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/MarketplaceTab';
import { mcpMessageRows } from '@/frontend/i18n/catalogs/mcp';

const boundedLabel = mcpMessageRows['mcp.marketplace.boundedSearch'][0];
const partialLabel = mcpMessageRows['mcp.marketplace.partialSearch'][0];

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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(await screen.findByText('Showing 2 of 2 loaded servers')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Verification' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Verified' }));

    expect(await screen.findByText('Showing 1 of 2 loaded servers')).toBeInTheDocument();
    expect(screen.getByText('Local tools')).toBeInTheDocument();
    expect(screen.queryByText('Remote tools')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeEnabled();
  });

  it.each([
    [{ bounded: true, partial: false, truncated: false }, true, false],
    [{ bounded: true, partial: true, truncated: false }, true, true],
    [{ bounded: true, partial: false, truncated: true }, true, true],
    [{ bounded: false, partial: false, truncated: false }, false, false],
    [{ bounded: 'true', partial: 'true', truncated: 1 }, false, false],
  ])('shows only explicit coverage flags for %j without turning usable results into an error', async (discovery, bounded, partial) => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ ...registryResponse, metadata: { discovery } }) });
    render(<MarketplaceTab onAdd={jest.fn()} onClose={jest.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search MCP servers' }), { target: { value: 'weather' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Local tools');
    expect(screen.queryAllByText(boundedLabel)).toHaveLength(bounded ? 1 : 0);
    expect(screen.queryAllByText(partialLabel)).toHaveLength(partial ? 1 : 0);
    expect(document.querySelector('.MuiAlert-standardError')).toBeNull();
  });

  it('preserves coverage through pagination and tab hide, then clears it for a new committed search', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ ...registryResponse, metadata: {
      nextCursor: 'more', discovery: { bounded: true, terms: ['weather', 'forecast'], partial: true, truncated: false },
    } }) });
    const onAdd = jest.fn(); const onClose = jest.fn();
    const view = (active = true) => <MarketplaceTab active={active} onAdd={onAdd} onClose={onClose} />;
    const { rerender } = render(view());
    fireEvent.change(screen.getByRole('textbox', { name: 'Search MCP servers' }), { target: { value: 'weather' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Local tools');
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, servers: [], metadata: {} }) });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument());
    rerender(view(false)); rerender(view());
    expect(screen.getByText(boundedLabel)).toBeVisible();
    expect(screen.getByText(partialLabel)).toBeVisible();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search MCP servers' }), { target: { value: 'calendar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Local tools');
    expect(screen.queryByText(boundedLabel)).not.toBeInTheDocument();
    expect(screen.queryByText(partialLabel)).not.toBeInTheDocument();
  });

  it('keeps an ordinary pagination failure visible alongside the bounded coverage notice', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ ...registryResponse, metadata: {
      nextCursor: 'more', discovery: { bounded: true, partial: false, truncated: false },
    } }) });
    render(<MarketplaceTab onAdd={jest.fn()} onClose={jest.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search MCP servers' }), { target: { value: 'weather' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Local tools');
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ success: false, error: 'Registry temporarily unavailable' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText(/Registry temporarily unavailable/);
    expect(screen.getByText(boundedLabel)).toBeVisible();
    expect(screen.getByText('Local tools')).toBeInTheDocument();
    expect(document.querySelector('.MuiAlert-standardError')).toBeInTheDocument();
  });
});
