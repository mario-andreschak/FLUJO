/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import PersonaMemoryArea from '@/frontend/components/Personas/PersonaMemoryArea';
import { PersonasApiError, personasService, type PersonaDetail } from '@/frontend/services/personas';
import type { MemoryItem } from '@/shared/types/enduringAgent';

const original: MemoryItem = {
  schemaVersion: 1,
  id: 'memory_original',
  personaId: 'persona_history',
  kind: 'semantic',
  scope: 'persona',
  status: 'superseded',
  content: 'The release is on Monday.',
  confidence: 1,
  importance: 0.8,
  sourceRefs: [{ kind: 'user_statement', id: 'statement_original' }],
  trust: 'explicit_user',
  createdAt: 10,
  updatedAt: 11,
};

const corrected: MemoryItem = {
  ...original,
  id: 'memory_corrected',
  status: 'active',
  content: 'The release is on Tuesday.',
  supersedes: [original.id],
  sourceRefs: [{ kind: 'user_statement', id: 'statement_correction' }],
  validFrom: new Date(2027, 0, 5, 12, 34, 56, 789).getTime(),
  validUntil: new Date(2027, 1, 10, 15, 45, 12, 345).getTime(),
  createdAt: 20,
  updatedAt: 21,
};

const detail = {
  persona: {
    id: 'persona_history',
    coreMemoryItemIds: [],
  },
  memoryItems: [corrected, original],
} as unknown as PersonaDetail;

describe('PersonaMemoryArea dialog feedback and focus', () => {
  beforeEach(() => {
    jest.spyOn(personasService, 'memories').mockResolvedValue([]);
  });
  afterEach(() => jest.restoreAllMocks());

  it('keeps failed additions and their error inside the dialog', async () => {
    jest.spyOn(personasService, 'createMemory').mockRejectedValue(new Error('Memory storage is unavailable.'));
    render(<PersonaMemoryArea detail={detail} busy={false} refresh={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a memory' });
    const input = within(dialog).getByRole('textbox', { name: 'What should this Persona remember?' });
    fireEvent.change(input, { target: { value: 'Keep this draft.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add memory' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Memory storage is unavailable.');
    expect(input).toHaveValue('Keep this draft.');
    expect(within(dialog).getByRole('button', { name: 'Add memory' })).toBeEnabled();
  });

  it('keeps correction errors accessible without closing the draft', async () => {
    jest.spyOn(personasService, 'correctMemory').mockRejectedValue(new Error('Correction could not be saved.'));
    render(<PersonaMemoryArea detail={detail} busy={false} refresh={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Correct' }));
    const dialog = screen.getByRole('dialog', { name: 'Correct' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByText('Correction could not be saved.')).closest('[role=alert]')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'What should this Persona remember?' })).toHaveValue(corrected.content);
  });

  it('keeps the inspected revision until the owner reviews a concurrent replacement', async () => {
    const replacement = { ...corrected, id: 'memory_concurrent', content: 'The release is on Thursday.', supersedes: [corrected.id], updatedAt: 31 };
    const next = { ...detail, memoryItems: [replacement, { ...corrected, status: 'superseded' as const, updatedAt: 32 }, original] };
    const correctMemory = jest.spyOn(personasService, 'correctMemory')
      .mockRejectedValueOnce(new PersonasApiError(409, 'Changed.', 'memory_changed'))
      .mockResolvedValue({ ...replacement, id: 'memory_reviewed', content: 'My proposed Wednesday.' });
    const refresh = jest.fn().mockResolvedValue(undefined);
    const view = render(<PersonaMemoryArea detail={detail} busy={false} refresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Correct' }));
    const dialog = screen.getByRole('dialog', { name: 'Correct' });
    const input = within(dialog).getByRole('textbox', { name: 'What should this Persona remember?' });
    fireEvent.change(input, { target: { value: 'My proposed Wednesday.' } });
    view.rerender(<PersonaMemoryArea detail={next} busy={false} refresh={refresh} />);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(correctMemory).toHaveBeenNthCalledWith(1, detail.persona.id,
      expect.objectContaining({ id: corrected.id, updatedAt: corrected.updatedAt, status: 'active' }),
      'My proposed Wednesday.', expect.any(Object)));
    expect(await within(dialog).findByText(replacement.content)).toBeInTheDocument();
    expect(input).toHaveValue('My proposed Wednesday.');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue with this version' }));
    expect(input).toHaveValue('My proposed Wednesday.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(correctMemory).toHaveBeenNthCalledWith(2, detail.persona.id,
      expect.objectContaining({ id: replacement.id, updatedAt: replacement.updatedAt }),
      'My proposed Wednesday.', expect.any(Object)));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('returns focus to the corrected Memory after its original card is replaced', async () => {
    const replacement = { ...corrected, id: 'memory_replacement', content: 'The release is on Friday.', supersedes: [corrected.id] };
    jest.spyOn(personasService, 'correctMemory').mockResolvedValue(replacement);
    const next = { ...detail, memoryItems: [replacement, { ...corrected, status: 'superseded' as const }, original] };
    const refresh = jest.fn(async () => view.rerender(<PersonaMemoryArea detail={next} busy={false} refresh={refresh} />));
    const view = render(<PersonaMemoryArea detail={detail} busy={false} refresh={refresh} />);
    const trigger = screen.getByRole('button', { name: 'Correct' });
    act(() => trigger.focus());
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Correct' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'What should this Persona remember?' }), { target: { value: replacement.content } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Correct' })).toHaveFocus());
    expect(trigger).not.toBeInTheDocument();
    expect(screen.getByText(replacement.content)).toBeInTheDocument();
  });

  it('returns to Add memory when the corrected text no longer matches the search', async () => {
    const replacement = { ...corrected, id: 'memory_replacement', content: 'The review is on Friday.', supersedes: [corrected.id] };
    jest.spyOn(personasService, 'correctMemory').mockResolvedValue(replacement);
    const next = { ...detail, memoryItems: [replacement, { ...corrected, status: 'superseded' as const }, original] };
    const refresh = jest.fn(async () => view.rerender(<PersonaMemoryArea detail={next} busy={false} refresh={refresh} />));
    const view = render(<PersonaMemoryArea detail={detail} busy={false} refresh={refresh} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search memories' }), { target: { value: 'Tuesday' } });
    const trigger = screen.getByRole('button', { name: 'Correct' });
    act(() => trigger.focus());
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Correct' })).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add memory' })).toHaveFocus());
  });

  it('returns correction cancellation to its existing trigger', async () => {
    render(<PersonaMemoryArea detail={detail} busy={false} refresh={jest.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Correct' });
    act(() => trigger.focus());
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Correct' })).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('starts Forget on Cancel and retains a failed request inside the dialog', async () => {
    jest.spyOn(personasService, 'forgetMemory').mockRejectedValue(new Error('Forget could not be saved.'));
    render(<PersonaMemoryArea detail={detail} busy={false} refresh={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Forget' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Forget could not be saved.');
  });

  it('returns to Add memory after Forget removes its trigger', async () => {
    jest.spyOn(personasService, 'forgetMemory').mockResolvedValue({ ...corrected, status: 'forgotten' });
    const next = { ...detail, memoryItems: [{ ...corrected, status: 'forgotten' as const }, original] };
    const refresh = jest.fn(async () => view.rerender(<PersonaMemoryArea detail={next} busy={false} refresh={refresh} />));
    const view = render(<PersonaMemoryArea detail={detail} busy={false} refresh={refresh} />);
    const trigger = screen.getByRole('button', { name: 'Forget' });
    act(() => trigger.focus());
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add memory' })).toHaveFocus());
  });

  it('does not move focus into another Persona when a dialog finishes closing', async () => {
    const refresh = jest.fn();
    const view = render(<PersonaMemoryArea detail={detail} busy={false} refresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Correct' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    const other = { ...detail, persona: { ...detail.persona, id: 'persona_other' }, memoryItems: [] };
    view.rerender(<PersonaMemoryArea detail={other} busy={false} refresh={refresh} />);
    const search = screen.getByLabelText('Search memories');
    act(() => search.focus());
    await waitFor(() => expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument());
    expect(search).toHaveFocus();
  });
});

describe('PersonaMemoryArea correction history', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps superseded memories out of the main list but reveals their exact text', () => {
    render(
      <PersonaMemoryArea
        detail={detail}
        busy={false}
        refresh={jest.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText(corrected.content)).toBeInTheDocument();
    expect(screen.queryByText(original.content)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'See earlier versions (1)' }));

    expect(screen.getByRole('heading', { name: 'Earlier versions' })).toBeInTheDocument();
    expect(screen.getByText(original.content)).toBeInTheDocument();
    expect(screen.getByText(/Replaced on/)).toBeInTheDocument();
  });

  it('shows when a memory is useful without exposing internal scoring metadata', () => {
    render(
      <PersonaMemoryArea
        detail={detail}
        busy={false}
        refresh={jest.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText(/Useful from .* until .*/)).toBeInTheDocument();
    expect(screen.queryByText(/confidence|trust|conflict/i)).not.toBeInTheDocument();
  });

  it('adds optional availability dates and prevents an inverted range', async () => {
    const createMemory = jest.spyOn(personasService, 'createMemory')
      .mockResolvedValue(corrected);
    const refresh = jest.fn().mockResolvedValue(undefined);
    render(<PersonaMemoryArea detail={detail} busy={false} refresh={refresh} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a memory' });
    fireEvent.change(within(dialog).getByRole('textbox', {
      name: 'What should this Persona remember?',
    }), { target: { value: 'The launch window is in February.' } });
    fireEvent.change(within(dialog).getByLabelText('Useful from (optional)'), {
      target: { value: '2027-02-10' },
    });
    fireEvent.change(within(dialog).getByLabelText('Useful until (optional)'), {
      target: { value: '2027-02-01' },
    });

    expect(within(dialog).getByText(/must be the same day as or later/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add memory' })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Useful until (optional)'), {
      target: { value: '2027-02-28' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add memory' }));

    await waitFor(() => expect(createMemory).toHaveBeenCalledWith(
      'persona_history',
      {
        content: 'The launch window is in February.',
        requestId: expect.any(String),
        validFrom: new Date(2027, 1, 10, 0, 0, 0, 0).getTime(),
        validUntil: new Date(2027, 1, 28, 23, 59, 59, 999).getTime(),
      },
    ));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('preserves exact availability timestamps when correcting only the text', async () => {
    const correctMemory = jest.spyOn(personasService, 'correctMemory')
      .mockResolvedValue({ ...corrected, content: 'The release is on Wednesday.' });
    const refresh = jest.fn().mockResolvedValue(undefined);
    render(<PersonaMemoryArea detail={detail} busy={false} refresh={refresh} />);

    fireEvent.click(screen.getByRole('button', { name: 'Correct' }));
    const dialog = screen.getByRole('dialog', { name: 'Correct' });
    expect(within(dialog).getByLabelText('Useful from (optional)')).toHaveValue('2027-01-05');
    expect(within(dialog).getByLabelText('Useful until (optional)')).toHaveValue('2027-02-10');
    fireEvent.change(within(dialog).getByRole('textbox', {
      name: 'What should this Persona remember?',
    }), { target: { value: 'The release is on Wednesday.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(correctMemory).toHaveBeenCalledWith(
      'persona_history',
      corrected,
      'The release is on Wednesday.',
      {
        validFrom: corrected.validFrom,
        validUntil: corrected.validUntil,
      },
    ));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('processes selected review candidates sequentially and keeps failures retryable', async () => {
    const now = Date.now();
    const candidates = ['one', 'two', 'three'].map((suffix, index): MemoryItem => ({
      ...corrected,
      id: `memory_${suffix}`,
      status: 'candidate',
      content: `Candidate ${suffix}`,
      trust: 'model_inference',
      sourceRefs: [{ kind: 'conversation', id: `conversation_${suffix}` }],
      reviewedAt: undefined,
      expiresAt: now + (index + 1) * 24 * 60 * 60 * 1000,
    }));
    const reviewDetail = {
      ...detail,
      memoryItems: candidates,
    } as PersonaDetail;
    jest.spyOn(personasService, 'memories').mockResolvedValue(candidates.map((item, index) => ({
      item,
      score: 1 - index / 10,
      core: false,
    })));
    let concurrent = 0;
    let maximumConcurrent = 0;
    const calls: string[] = [];
    jest.spyOn(personasService, 'activateMemory').mockImplementation(async (_personaId, memoryId) => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      calls.push(memoryId);
      await Promise.resolve();
      concurrent -= 1;
      if (memoryId === 'memory_two') throw new Error('Review failed.');
      return { ...candidates.find(item => item.id === memoryId)!, status: 'active' };
    });

    render(
      <PersonaMemoryArea
        detail={reviewDetail}
        busy={false}
        refresh={jest.fn().mockResolvedValue(undefined)}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Select all shown' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve selected (3)' }));

    expect(await screen.findByText(/2 succeeded, 1 failed, and 0 skipped/)).toBeInTheDocument();
    expect(calls).toEqual(['memory_one', 'memory_two', 'memory_three']);
    expect(maximumConcurrent).toBe(1);
    expect(screen.getByLabelText('Select memory: Candidate two')).toBeChecked();
  });

  it('shows expiry and resolves a safe same-Persona conflict through the backend', async () => {
    const counterpart: MemoryItem = {
      ...corrected,
      id: 'memory_counterpart',
      content: 'The release is on Thursday.',
    };
    const candidate: MemoryItem = {
      ...corrected,
      id: 'memory_candidate',
      status: 'candidate',
      content: 'The release is on Friday.',
      trust: 'model_inference',
      sourceRefs: [{ kind: 'conversation', id: 'conversation_candidate' }],
      conflictsWith: [counterpart.id],
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    };
    const conflictDetail = { ...detail, memoryItems: [candidate, counterpart] } as PersonaDetail;
    jest.spyOn(personasService, 'memories').mockResolvedValue([{
      item: candidate,
      score: 1,
      core: false,
    }]);
    const resolve = jest.spyOn(personasService, 'resolveMemoryConflict').mockResolvedValue({
      resolutionId: 'memory_resolution_ui',
      audit: {
        resolutionId: 'memory_resolution_ui',
        memoryIds: [candidate.id, counterpart.id],
        action: 'keep_left',
        winnerId: candidate.id,
        actor: 'user',
        authority: 'manual_api',
        reason: 'Friday was confirmed.',
        resolvedAt: Date.now(),
      },
      left: candidate,
      right: { ...counterpart, status: 'superseded' },
    });

    render(<PersonaMemoryArea detail={conflictDetail} busy={false} refresh={jest.fn()} />);
    expect(await screen.findByText('Expires today.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resolve conflict' }));
    const dialog = screen.getByRole('dialog', { name: 'Resolve memory conflict' });
    fireEvent.change(within(dialog).getByLabelText('Reason for this decision'), {
      target: { value: 'Friday was confirmed.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep this memory' }));

    await waitFor(() => expect(resolve).toHaveBeenCalledWith(
      'persona_history',
      candidate.id,
      expect.objectContaining({
        counterpartId: counterpart.id,
        action: 'keep_left',
        reason: 'Friday was confirmed.',
      }),
    ));
  });
});
