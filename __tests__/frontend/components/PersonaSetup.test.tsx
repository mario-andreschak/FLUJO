/** @jest-environment jsdom */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { PersonaDetail } from '@/frontend/services/personas';

const getFlowMock = jest.fn();
jest.mock('@/frontend/services/flow', () => ({
  flowService: { getFlow: (...args: unknown[]) => getFlowMock(...args) },
}));
import PersonaSetup from '@/frontend/components/Personas/PersonaSetup';

const detail = {
  persona: { id: 'frederik', composition: { coreFlowRef: 'internal-core-id' } },
  roleVersion: { name: 'Marketing Agent', version: 1 },
  behaviorBindings: [], appGrants: [],
  memoryItems: [{ status: 'active' }, { status: 'candidate' }, { status: 'superseded' }, { status: 'forgotten' }],
} as unknown as PersonaDetail;

it('shows a recognizable Core name and excludes superseded and forgotten memories', async () => {
  getFlowMock.mockResolvedValue({ id: 'internal-core-id', name: 'Frederik Core' });
  render(<PersonaSetup detail={detail} />);
  expect(screen.queryByText('internal-core-id')).not.toBeInTheDocument();
  expect(await screen.findByText('Frederik Core')).toBeInTheDocument();
  expect(within(screen.getByText('Memories').parentElement!).getByText('2')).toBeInTheDocument();
});

it('never exposes raw references or a stale name when the Core changes during lookup', async () => {
  let resolveOld!: (flow: { id: string; name: string }) => void;
  getFlowMock.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
    .mockResolvedValueOnce(null);
  const { rerender } = render(<PersonaSetup detail={detail} />);
  rerender(<PersonaSetup detail={{ ...detail, persona: { ...detail.persona,
    composition: { ...detail.persona.composition!, coreFlowRef: 'unavailable-core-id' },
  } }} />);
  await act(async () => { resolveOld({ id: 'internal-core-id', name: 'Stale Core' }); });
  await waitFor(() => expect(getFlowMock).toHaveBeenCalledWith('unavailable-core-id'));
  expect(screen.queryByText(/internal-core-id|unavailable-core-id|Stale Core/)).not.toBeInTheDocument();
});
