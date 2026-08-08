/**
 * The shared registry install pipeline (#392): one picker for Spotlight and
 * Marketplace, and graceful degradation for launch-and-connect entries.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { InstallOptionList } from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/components/InstallOptionPicker';
import { getInstallOptions, type RegistryServer } from '@/utils/mcp/registry';

const server = (overrides: Partial<RegistryServer>): RegistryServer => ({
  name: 'io.github.example/weather-mcp',
  description: 'Weather data for MCP',
  version: '1.0.0',
  ...overrides,
});

const stdioServer = server({
  packages: [{ registryType: 'npm', identifier: '@example/weather-mcp', transport: { type: 'stdio' } }],
});

const manualServer = server({
  packages: [{
    registryType: 'oci',
    identifier: 'example/weather-mcp',
    version: '1.0.0',
    transport: { type: 'streamable-http', url: 'http://localhost:{PORT}/mcp' },
    environmentVariables: [{ name: 'PORT', default: '8088' }],
  }],
});

describe('InstallOptionList', () => {
  it('installs a normal package option on click', () => {
    const onSelect = jest.fn();
    render(<InstallOptionList options={getInstallOptions(stdioServer)} onSelect={onSelect} />);

    fireEvent.click(screen.getByText('npm: @example/weather-mcp'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('blocks selection while the trust gate is unconfirmed (marketplace mode)', () => {
    const onSelect = jest.fn();
    render(<InstallOptionList options={getInstallOptions(stdioServer)} disabled onSelect={onSelect} />);

    fireEvent.click(screen.getByText('npm: @example/weather-mcp'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows a launch-and-connect entry with its exact command and resolved URL', () => {
    render(<InstallOptionList options={getInstallOptions(manualServer)} onSelect={jest.fn()} />);

    expect(screen.getByText(/Needs a manual start/i)).toBeInTheDocument();
    expect(screen.getByText(/docker run -i --rm example\/weather-mcp:1\.0\.0/)).toBeInTheDocument();
    expect(screen.getByText('http://localhost:8088/mcp')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy command/i })).toBeInTheDocument();
  });

  it('hands a launch-and-connect entry off through "Configure as remote"', () => {
    const onConfigureAsRemote = jest.fn();
    render(
      <InstallOptionList
        options={getInstallOptions(manualServer)}
        onSelect={jest.fn()}
        onConfigureAsRemote={onConfigureAsRemote}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /configure as remote/i }));
    expect(onConfigureAsRemote).toHaveBeenCalledTimes(1);
    expect(onConfigureAsRemote.mock.calls[0][0].kind).toBe('manual-launch');
  });

  it('treats a curated env default as a provided required input (spotlight mode)', () => {
    const withRequiredEnv = server({
      packages: [{
        registryType: 'npm',
        identifier: '@example/weather-mcp',
        transport: { type: 'stdio' },
        environmentVariables: [{ name: 'API_KEY', isRequired: true }],
      }],
    });

    const { rerender } = render(
      <InstallOptionList options={getInstallOptions(withRequiredEnv)} onSelect={jest.fn()} />,
    );
    expect(screen.getByText(/API_KEY/)).toBeInTheDocument();

    rerender(
      <InstallOptionList
        options={getInstallOptions(withRequiredEnv)}
        envDefaults={{ API_KEY: 'curated' }}
        onSelect={jest.fn()}
      />,
    );
    expect(screen.queryByText(/API_KEY/)).not.toBeInTheDocument();
  });
});
