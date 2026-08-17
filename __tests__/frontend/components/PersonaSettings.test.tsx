/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const optionsMock = jest.fn();
const updateMock = jest.fn();
const deletionPreviewMock = jest.fn();

jest.mock('@/frontend/services/personas/settings', () => ({
  personaSettingsService: {
    options: (...args: unknown[]) => optionsMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
    get: jest.fn(),
    exportPreview: jest.fn(),
    exportConfiguration: jest.fn(),
    deletionPreview: (...args: unknown[]) => deletionPreviewMock(...args),
    delete: jest.fn(),
  },
}));

import PersonaSettings from '@/frontend/components/Personas/settings/PersonaSettings';
import type { PersonaDetail } from '@/frontend/services/personas';

const persona = {
  schemaVersion: 1,
  id: 'persona_picture',
  name: 'Mina',
  mission: 'Prepare careful launches.',
  roleVersionId: 'rolever_1',
  lifecycleState: 'idle',
  autonomyLevel: 'propose_overrides',
  interruptionPolicy: 'queue',
  provisioningState: 'ready',
  presentation: { avatarUrl: 'https://example.test/mina.png' },
  createdAt: 10,
  updatedAt: 20,
} as const;

const detail = {
  persona,
  roleVersion: { name: 'Launch coordinator', version: 1 },
} as unknown as PersonaDetail;

describe('PersonaSettings editing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    optionsMock.mockResolvedValue({
      roles: [
        {
          roleVersionId: 'rolever_1',
          name: 'Launch coordinator',
          description: 'Coordinates careful launches.',
        },
        {
          roleVersionId: 'rolever_research',
          name: 'Research lead',
          description: 'Finds and weighs reliable evidence.',
        },
      ],
      languages: [],
      lifecycleStates: ['idle', 'sleeping', 'disabled'],
      autonomyLevels: [
        'locked',
        'learn_hints',
        'propose_overrides',
        'auto_apply_validated',
      ],
      interruptionPolicies: ['queue', 'related_only', 'allow_urgent'],
    });
    updateMock.mockResolvedValue({
      ...persona,
      presentation: undefined,
      updatedAt: 21,
    });
  });

  it('lets a user remove an existing picture and saves the change', async () => {
    const onRefresh = jest.fn().mockResolvedValue(undefined);
    render(
      <PersonaSettings
        detail={detail}
        onRefresh={onRefresh}
        onDeleted={jest.fn()}
      />,
    );

    expect(screen.getByLabelText('Picture link (optional)')).toHaveValue(
      'https://example.test/mina.png',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove picture' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith(
      'persona_picture',
      expect.objectContaining({
        presentation: expect.objectContaining({ avatarUrl: null }),
      }),
    ));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('uses readable Role names and saves a future-work Role choice', async () => {
    render(
      <PersonaSettings
        detail={detail}
        onRefresh={jest.fn().mockResolvedValue(undefined)}
        onDeleted={jest.fn()}
      />,
    );

    expect(await screen.findByText('Coordinates careful launches.')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByLabelText('Role'));
    fireEvent.click(await screen.findByRole('option', { name: 'Research lead' }));
    expect(screen.getByText(/future work only/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith(
      'persona_picture',
      expect.objectContaining({
        roleVersionId: 'rolever_research',
        expectedUpdatedAt: 20,
      }),
    ));
  });

  it('retries a failed deletion preview and keeps confirmation disabled until it loads', async () => {
    deletionPreviewMock
      .mockRejectedValueOnce(new Error('Preview temporarily unavailable'))
      .mockResolvedValueOnce({
        personaId: 'persona_picture',
        workspaceId: 'workspace_1',
        generatedAt: 30,
        previewToken: 'preview_1',
        counts: {
          behaviorBindings: 0,
          behaviorRevisions: 0,
          behaviorProposals: 0,
          behaviorMaintenanceRuns: 0,
          behaviorOutcomeMetrics: 0,
          appGrants: 0,
          memoryItems: 2,
          memoryEmbeddings: 0,
          workItems: 1,
          liveActivities: 0,
          archivedActivities: 0,
          openMailboxItems: 0,
          archivedMailboxItems: 0,
          leaseRecords: 0,
          coreMemoryItems: 0,
          homeFiles: 3,
          homeBytes: 10,
        },
        activeLease: false,
        homeExists: true,
        referencedArchiveEvidence: {
          activities: 0,
          mailboxItems: 0,
          futureCrossSystemAttributionPolicy: 'anonymize_or_minimal_tombstone',
        },
        externalSharedResources: { mcpConfigNames: [], action: 'retained' },
        backupPolicy: {
          action: 'retained_until_workspace_backup_expiry',
          immediatePurgeSupported: false,
        },
      });

    render(
      <PersonaSettings
        detail={detail}
        onRefresh={jest.fn().mockResolvedValue(undefined)}
        onDeleted={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete Persona' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Preview temporarily unavailable')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete Persona' })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(deletionPreviewMock).toHaveBeenCalledTimes(2));
    expect(await within(dialog).findByText(/2 memories, 1 work items/)).toBeInTheDocument();
    const confirmButton = within(dialog).getByRole('button', { name: 'Delete Persona' });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Type DELETE to confirm'), {
      target: { value: 'DELETE' },
    });
    expect(confirmButton).toBeEnabled();
  });

  it('keeps an unavailable saved Role visible until another Role is chosen', async () => {
    optionsMock.mockResolvedValue({
      roles: [{
        roleVersionId: 'rolever_research',
        name: 'Research lead',
        description: 'Finds and weighs reliable evidence.',
      }],
      languages: [],
      lifecycleStates: ['idle', 'sleeping', 'disabled'],
      autonomyLevels: [
        'locked',
        'learn_hints',
        'propose_overrides',
        'auto_apply_validated',
      ],
      interruptionPolicies: ['queue', 'related_only', 'allow_urgent'],
    });

    render(
      <PersonaSettings
        detail={detail}
        onRefresh={jest.fn().mockResolvedValue(undefined)}
        onDeleted={jest.fn()}
      />,
    );

    expect(await screen.findByText(
      /saved Role “Launch coordinator” is no longer available/i,
    )).toBeInTheDocument();
    expect(screen.getByText('Launch coordinator (no longer available)')).toBeInTheDocument();
  });
});
