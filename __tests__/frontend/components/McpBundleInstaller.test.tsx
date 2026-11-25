/**
 * Dropping an MCP bundle (.mcpb) on the Connected Apps page (#1230): FLUJO
 * reviews it first and installs only after the person presses Install.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mcpBundleMessageRows } from '@/frontend/i18n/catalogs/mcpBundles';
import { useMcpBundleInstaller } from '@/frontend/components/mcp/MCPServerManager/McpBundleInstaller';
import type { McpbInstallResult, McpbReview } from '@/shared/types/mcp/mcpb';

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({
    t: (key: string, values: Record<string, string | number> = {}) => {
      const row = mcpBundleMessageRows[key as keyof typeof mcpBundleMessageRows];
      const text: string = row ? row[0] : key;
      return text.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? `{${name}}`));
    },
    formatNumber: String,
  }),
}));

function review(overrides: Partial<McpbReview> = {}): McpbReview {
  return {
    digest: 'a'.repeat(64),
    manifestName: 'hello-bundle',
    displayName: 'Hello Bundle',
    version: '1.0.0',
    manifestVersion: '0.3',
    description: 'Says hello.',
    author: { name: 'Ada Example' },
    serverType: 'node',
    launch: { command: 'node', args: ['<bundle folder>/server/index.js'], envNames: ['API_KEY'] },
    runtimes: {},
    flujoNodeVersion: '22.23.4',
    platforms: [],
    thisPlatform: 'win32',
    platformSupported: true,
    tools: [{ name: 'hello', description: 'Say hello' }],
    toolsGenerated: false,
    prompts: [],
    promptsGenerated: false,
    privacyPolicies: [],
    userConfig: [
      { key: 'api_key', type: 'string', title: 'API key', description: 'Your key', required: true, sensitive: true, multiple: false },
      { key: 'verbose', type: 'boolean', title: 'Verbose', description: '', required: false, sensitive: false, multiple: false, default: true },
    ],
    signature: { status: 'unsigned' },
    files: { count: 2, packedBytes: 2048, unpackedBytes: 4096 },
    suggestedServerName: 'hello-bundle',
    warnings: [],
    ...overrides,
  };
}

const installed: McpbInstallResult = { installed: true, serverName: 'hello-bundle', upgraded: false, version: '1.0.0' };

function Harness({ onInstalled }: { onInstalled: (result: McpbInstallResult) => void }) {
  const installer = useMcpBundleInstaller({ onInstalled });
  return (
    <div data-testid="page" {...installer.dropZoneProps}>
      <button type="button" onClick={installer.openFilePicker}>pick</button>
      {installer.element}
    </div>
  );
}

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

function respond(status: number, body: unknown) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);
}

function drop(file: File) {
  fireEvent.drop(screen.getByTestId('page'), { dataTransfer: { types: ['Files'], files: [file] } });
}

const bundleFile = () => new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'hello.mcpb', { type: 'application/zip' });

it('reviews a dropped bundle and installs it only after Install is pressed', async () => {
  const onInstalled = jest.fn();
  fetchMock.mockImplementationOnce(() => respond(200, review())).mockImplementationOnce(() => respond(201, installed));
  render(<Harness onInstalled={onInstalled} />);

  drop(bundleFile());
  expect(await screen.findByText('Hello Bundle')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const reviewForm = fetchMock.mock.calls[0][1].body as FormData;
  expect(reviewForm.get('action')).toBe('review');
  expect(screen.getByText('node <bundle folder>/server/index.js')).toBeInTheDocument();
  expect(screen.getByText('Not signed')).toBeInTheDocument();

  const secret = screen.getByLabelText(/API key/);
  expect(secret).toHaveAttribute('type', 'password');
  fireEvent.change(secret, { target: { value: 'secret-1' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Install' })); });

  await waitFor(() => expect(onInstalled).toHaveBeenCalledWith(installed));
  const installForm = fetchMock.mock.calls[1][1].body as FormData;
  expect(installForm.get('action')).toBe('install');
  expect(installForm.get('reviewedDigest')).toBe('a'.repeat(64));
  expect(installForm.get('serverName')).toBe('hello-bundle');
  expect(JSON.parse(String(installForm.get('userConfig')))).toEqual({ api_key: 'secret-1', verbose: true });
  expect(screen.getByText('hello-bundle is installed and starting. Its card is in the list.')).toBeInTheDocument();
});

it('refuses other files without sending them anywhere', async () => {
  render(<Harness onInstalled={jest.fn()} />);
  drop(new File(['{}'], 'servers.json', { type: 'application/json' }));
  expect(await screen.findByText('Only MCP bundle files (.mcpb) can be installed this way.')).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('blocks Install for another platform and shows why', async () => {
  fetchMock.mockImplementationOnce(() => respond(200, review({ platformSupported: false, platforms: ['darwin'], thisPlatform: 'win32' })));
  render(<Harness onInstalled={jest.fn()} />);
  drop(bundleFile());
  expect(await screen.findByText('This bundle is not made for this computer (Windows). It works on: macOS.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();
});

it('shows the server\'s words and marks the setting at fault when Install fails', async () => {
  fetchMock
    .mockImplementationOnce(() => respond(200, review()))
    .mockImplementationOnce(() => respond(400, { error: 'Fill in "API key" before installing.', code: 'missing-config', fields: ['api_key'] }));
  const onInstalled = jest.fn();
  render(<Harness onInstalled={onInstalled} />);
  drop(bundleFile());
  await screen.findByText('Hello Bundle');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Install' })); });
  expect(await screen.findByRole('alert')).toHaveTextContent('Fill in "API key" before installing.');
  expect(screen.getByLabelText(/API key/)).toHaveAttribute('aria-invalid', 'true');
  expect(onInstalled).not.toHaveBeenCalled();
});

it('offers an upgrade with the saved secret kept', async () => {
  fetchMock.mockImplementationOnce(() => respond(200, review({
    version: '2.0.0',
    existing: { serverName: 'hello-bundle', version: '1.0.0' },
    userConfig: [{ key: 'api_key', type: 'string', title: 'API key', description: '', required: true, sensitive: true, multiple: false, hasSavedSecret: true }],
  })));
  render(<Harness onInstalled={jest.fn()} />);
  drop(bundleFile());
  expect(await screen.findByText('Update hello-bundle')).toBeInTheDocument();
  expect(screen.getByText(/hello-bundle 1\.0\.0 is installed\. Installing replaces it with version 2\.0\.0/)).toBeInTheDocument();
  expect(screen.getByText(/Leave empty to keep the saved value\./)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled();
});

it('opens the file picker from a button for keyboard users', async () => {
  fetchMock.mockImplementationOnce(() => respond(200, review()));
  render(<Harness onInstalled={jest.fn()} />);
  const input = screen.getByTestId('mcpb-file-input') as HTMLInputElement;
  const click = jest.spyOn(input, 'click');
  fireEvent.click(screen.getByRole('button', { name: 'pick' }));
  expect(click).toHaveBeenCalled();
  fireEvent.change(input, { target: { files: [bundleFile()] } });
  expect(await screen.findByText('Hello Bundle')).toBeInTheDocument();
});
