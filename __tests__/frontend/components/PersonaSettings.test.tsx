/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const optionsMock = jest.fn();
const updateMock = jest.fn();

jest.mock('@/frontend/services/personas/settings', () => ({
  personaSettingsService: {
    options: (...args: unknown[]) => optionsMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
    get: jest.fn(),
    exportPreview: jest.fn(),
    exportConfiguration: jest.fn(),
    deletionPreview: jest.fn(),
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
