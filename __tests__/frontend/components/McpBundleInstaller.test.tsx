/**
 * Dropping an MCP bundle (.mcpb) on the Connected Apps page (#1230): FLUJO
 * reviews it first and installs only after the person presses Install.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mcpBundleMessageRows } from '@/frontend/i18n/catalogs/mcpBundles';
import { sharedMessageRows } from '@/frontend/i18n/catalogs/shared';
import { useMcpBundleInstaller } from '@/frontend/components/mcp/MCPServerManager/McpBundleInstaller';
import type { McpbInstallResult, McpbReview } from '@/shared/types/mcp/mcpb';

jest.mock('@/frontend/components/AskFlujo/AskFlujoButton', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/contexts/I18nContext', () => {
  const i18n = {
    t: (key: string, values: Record<string, string | number> = {}) => {
      const rows: Record<string, readonly string[]> = { ...sharedMessageRows, ...mcpBundleMessageRows };
      const row = rows[key];
      const text: string = row ? row[0] : key;
      return text.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? `{${name}}`));
    },
    formatNumber: String,
    formatDate: (value: string) => new Date(value).toISOString().slice(0, 10),
  };
  return { useI18n: () => i18n };
});

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

describe('the signature', () => {
  const signer = {
    name: 'Ada Example',
    organization: 'Example Tools',
    issuer: 'Test Root',
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: '2030-01-01T00:00:00.000Z',
    fingerprint: 'AA:BB',
  };

  async function showReview(overrides: Partial<McpbReview>) {
    fetchMock.mockImplementationOnce(() => respond(200, review(overrides)));
    render(<Harness onInstalled={jest.fn()} />);
    drop(bundleFile());
    await screen.findByText('Hello Bundle');
    return screen.getByTestId('mcpb-signature');
  }

  it('says who signed a checked bundle', async () => {
    const shown = await showReview({ signature: { status: 'signed', signer } });
    expect(shown).toHaveTextContent('Signed and checked');
    expect(shown).toHaveTextContent('Signed by Ada Example (Example Tools). The file has not changed since it was signed, and Test Root vouches for the signer. The certificate is valid until 2030-01-01.');
    expect(screen.getByRole('button', { name: 'Install' })).toBeEnabled();
  });

  it('blocks Install with the reason when the signature does not hold up', async () => {
    const shown = await showReview({ signature: { status: 'invalid', problem: 'expired', signer } });
    expect(shown).toHaveTextContent('Signature not valid');
    expect(shown).toHaveTextContent('The certificate that signed it expired on 2030-01-01. FLUJO will not install this bundle.');
    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();
  });

  it('allows an unsigned bundle with a note, and says when a signature proves nothing', async () => {
    const unsigned = await showReview({ signature: { status: 'unsigned' } });
    expect(unsigned).toHaveTextContent('Not signed');
    expect(unsigned).toHaveTextContent('FLUJO cannot tell who made this bundle or whether it was changed on the way.');
    expect(screen.getByRole('button', { name: 'Install' })).toBeEnabled();
  });

  it('names a signer that no trusted authority vouches for, without trusting it', async () => {
    const shown = await showReview({ signature: { status: 'unsigned', signer: { ...signer, name: 'Mallory', organization: undefined } } });
    expect(shown).toHaveTextContent('Not signed');
    expect(shown).toHaveTextContent('It carries a signature from “Mallory”, but no certificate authority this computer trusts vouches for that name');
    expect(shown).not.toHaveTextContent('Signed by');
  });

  it('warns when an update does not carry the signature of the installed version', async () => {
    await showReview({ existing: { serverName: 'hello-bundle', version: '1.0.0', signer: 'Ada Example' }, warnings: ['signer-changed'] });
    expect(screen.getByText('The installed version was signed by Ada Example. This file does not carry that signature, so it may come from someone else.')).toBeInTheDocument();
  });
});

describe('folder and file settings', () => {
  const pathSettings: McpbReview['userConfig'] = [
    { key: 'roots', type: 'directory', title: 'Folders', description: '', required: true, sensitive: false, multiple: true, default: ['/missing'] },
    { key: 'config', type: 'file', title: 'Config file', description: '', required: false, sensitive: false, multiple: false },
  ];
  const listing = (folder: string) => ({
    path: folder,
    parent: '/',
    home: '/home/ada',
    sep: '/',
    drives: [],
    entries: [
      { name: 'docs', path: `${folder}/docs`, isDirectory: true },
      { name: 'settings.json', path: `${folder}/settings.json`, isDirectory: false },
    ],
  });

  it('picks folders and files with FLUJO\'s folder browser, next to typing', async () => {
    const browsed: string[] = [];
    fetchMock.mockImplementation((url: string) => {
      if (!String(url).startsWith('/api/browse')) return respond(200, review({ userConfig: pathSettings }));
      browsed.push(String(url));
      const target = new URL(String(url), 'http://flujo.test').searchParams.get('path');
      if (target === '/missing') return respond(400, { error: 'This folder does not exist' });
      return respond(200, listing(target ?? '/home/ada'));
    });
    render(<Harness onInstalled={jest.fn()} />);
    drop(bundleFile());
    await screen.findByText('Hello Bundle');
    const folders = screen.getByLabelText(/^Folders/, { selector: 'textarea' });
    expect(folders).toHaveValue('/missing');

    fireEvent.click(screen.getByRole('button', { name: 'Choose folder: Folders' }));
    expect(await screen.findByText('docs')).toBeInTheDocument();
    expect(browsed).toEqual(['/api/browse?path=%2Fmissing', '/api/browse']);
    expect(screen.queryByText('This folder does not exist')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select this folder' }));
    await waitFor(() => expect(folders).toHaveValue('/missing\n/home/ada'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose folder: Folders' })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Choose file: Config file' }));
    expect(await screen.findByText('settings.json')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select this folder' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('settings.json'));
    await waitFor(() => expect(screen.getByLabelText(/^Config file/)).toHaveValue('/home/ada/settings.json'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose file: Config file' })).not.toBeInTheDocument());

    fireEvent.change(folders, { target: { value: '/typed/by/hand' } });
    expect(folders).toHaveValue('/typed/by/hand');
  });
});
