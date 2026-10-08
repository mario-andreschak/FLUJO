import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SnapshotStorageSettings from '@/frontend/components/Settings/SnapshotStorageSettings';
import {
  DEFAULT_SNAPSHOT_RETENTION_POLICY,
  type SnapshotStatus,
} from '@/shared/types/snapshot';

const updateSettings = jest.fn();
jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({
    settings: {
      experimental: {
        enabled: true,
        snapshotsEnabled: true,
      },
    },
    updateSettings,
  }),
}));

function makeStatus(overrides: Partial<SnapshotStatus> = {}): SnapshotStatus {
  return {
    policy: { ...DEFAULT_SNAPSHOT_RETENTION_POLICY },
    usage: {
      logicalBytes: 0,
      onDiskBytes: 0,
      repositoryCount: 0,
      repositories: [],
    },
    activity: {
      capture: false,
      cleanup: false,
      revert: false,
      migration: false,
      storageBusy: false,
      operatorDisabled: false,
      captureSuspended: false,
      localFolderAccess: false,
    },
    localFolderAccessSupported: true,
    overBudget: false,
    ...overrides,
  };
}

describe('SnapshotStorageSettings', () => {
  const originalFetch = global.fetch;
  let status: SnapshotStatus;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    updateSettings.mockReset();
    status = makeStatus();
    fetchMock = jest.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/snapshots' && !init?.method) {
        return { ok: true, json: async () => status };
      }
      if (input === '/api/snapshots/open-folder' && init?.method === 'POST') {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('renders an explicit empty repository state inside repository details', async () => {
    render(<SnapshotStorageSettings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Show repository details' }));

    expect(screen.getByText('No snapshot repositories yet')).toBeInTheDocument();
  });

  it('opens the snapshot folder without sending a path or body', async () => {
    render(<SnapshotStorageSettings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open snapshot folder' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/snapshots/open-folder',
      { method: 'POST' },
    ));
    const launchCall = fetchMock.mock.calls.find(
      ([input]) => input === '/api/snapshots/open-folder',
    );
    expect(launchCall?.[1]).not.toHaveProperty('body');
    expect(await screen.findByText('Snapshot folder opened.')).toBeInTheDocument();
  });

  it('disables duplicate launches while folder access is already active', async () => {
    status = makeStatus({
      activity: {
        ...makeStatus().activity,
        localFolderAccess: true,
      },
    });

    render(<SnapshotStorageSettings />);

    expect(await screen.findByRole('button', {
      name: 'Opening snapshot folder…',
    })).toBeDisabled();
  });

  it('uses server-derived storageBusy to disable destructive controls during capture', async () => {
    status = makeStatus({
      activity: {
        ...makeStatus().activity,
        capture: true,
        storageBusy: true,
      },
    });

    render(<SnapshotStorageSettings />);

    expect(await screen.findByRole('button', { name: 'Clean old snapshots' })).toBeDisabled();
    expect(screen.getByText(
      'Snapshot storage is busy; destructive actions are temporarily locked.',
    )).toBeInTheDocument();
  });

  it('surfaces only a path-free generic launch failure', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/snapshots' && !init?.method) {
        return { ok: true, json: async () => status };
      }
      return {
        ok: false,
        json: async () => ({
          error: 'C:\\private\\workspace\\snapshots launcher detail',
        }),
      };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<SnapshotStorageSettings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open snapshot folder' }));

    expect(await screen.findByText('Unable to open the snapshot folder.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('private');
    expect(document.body.textContent).not.toContain('launcher detail');
  });

  it('keeps safe repository labels and usage visible for non-empty stores', async () => {
    status = makeStatus({
      usage: {
        logicalBytes: 1024,
        onDiskBytes: 2048,
        repositoryCount: 1,
        repositories: [{
          id: '0123456789abcdef',
          label: 'Snapshot repository 01234567',
          logicalBytes: 1024,
          onDiskBytes: 2048,
          commitCount: 2,
          health: 'healthy',
        }],
      },
    });

    render(<SnapshotStorageSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show repository details' }));

    expect(screen.getByText(/Snapshot repository 01234567/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('C:\\');
  });
});
