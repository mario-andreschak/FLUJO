/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  BehaviorProposal,
  BehaviorProposalStatus,
} from '@/shared/types/enduringAgent';
import type { PersonaDetail } from '@/frontend/services/personas';

const improvementsMock = jest.fn();
const applyImprovementMock = jest.fn();
const rejectImprovementMock = jest.fn();
const undoImprovementMock = jest.fn();
const promoteImprovementMock = jest.fn();

jest.mock('@/frontend/services/personas', () => ({
  personasService: {
    improvements: (...args: unknown[]) => improvementsMock(...args),
    applyImprovement: (...args: unknown[]) => applyImprovementMock(...args),
    rejectImprovement: (...args: unknown[]) => rejectImprovementMock(...args),
    undoImprovement: (...args: unknown[]) => undoImprovementMock(...args),
    promoteImprovement: (...args: unknown[]) => promoteImprovementMock(...args),
  },
}));

import PersonaImprovementsArea from '@/frontend/components/Personas/PersonaImprovementsArea';

const detail = {
  persona: {
    id: 'jim',
    composition: {
      behaviors: [{
        ref: 'behavior_research',
        slotKey: 'research',
        name: 'Research specialist',
      }],
    },
  },
  roleVersion: {
    name: 'Developer',
    roleDefinitionId: 'role_research',
  },
} as PersonaDetail;

function proposal(
  status: BehaviorProposalStatus,
  overrides: Partial<BehaviorProposal> = {},
): BehaviorProposal {
  const activated = status === 'activated' || status === 'rolled_back';
  return {
    schemaVersion: 1,
    id: 'proposal_research',
    personaId: 'jim',
    behaviorId: 'behavior_research',
    slotKey: 'research',
    baseBehaviorRevisionId: 'revision_base',
    rationale: 'Recent work showed that sources should be checked before answering.',
    evidenceRefs: [{
      kind: 'activity',
      id: 'activity_1',
      observedAt: 10,
    }],
    candidateSpecDigest: 'a'.repeat(64),
    candidateFlow: { id: 'candidate_flow', name: 'Candidate', nodes: [], edges: [] },
    candidateContentHash: 'b'.repeat(64),
    validation: {
      compileSucceeded: true,
      errorCount: 0,
      warningCount: 0,
      issues: [],
    },
    evalResults: [{
      id: 'eval_1',
      passed: true,
      candidateContentHash: 'b'.repeat(64),
    }],
    status,
    ...(['approved', 'activated', 'rolled_back'].includes(status) ? {
      approval: {
        kind: 'manual' as const,
        actor: 'user',
        reason: 'Approved in the Improvements screen.',
        approvedAt: 12,
      },
    } : {}),
    ...(activated ? { activatedRevisionId: 'revision_candidate' } : {}),
    ...(status === 'rolled_back' ? { rollbackRevisionId: 'revision_base' } : {}),
    auditTrail: [{
      action: 'proposed',
      actor: 'persona',
      reason: 'Observed repeated evidence.',
      at: 10,
    }],
    createdAt: 10,
    updatedAt: 11,
    ...overrides,
  };
}

describe('PersonaImprovementsArea', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists a reviewed suggestion and applies it in place', async () => {
    const ready = proposal('awaiting_approval', {
      changeSummary: 'Check the sources before giving the final answer.',
    });
    improvementsMock.mockResolvedValue([ready]);
    applyImprovementMock.mockResolvedValue(proposal('activated'));

    render(<PersonaImprovementsArea detail={detail} />);

    expect(await screen.findByText('Research specialist')).toBeInTheDocument();
    expect(improvementsMock).toHaveBeenCalledWith('jim');
    expect(screen.getByText('Ready for your review')).toBeInTheDocument();
    expect(screen.getByText('1 safety check(s) passed')).toBeInTheDocument();
    expect(screen.getByText('Recent Persona work')).toBeInTheDocument();
    expect(screen.getByText('What it will do differently')).toBeInTheDocument();
    expect(screen.getByText('Check the sources before giving the final answer.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Use this improvement' }));

    await waitFor(() => expect(applyImprovementMock).toHaveBeenCalledWith(
      'jim',
      ready.id,
    ));
    expect(await screen.findByText('In use')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo improvement' })).toBeInTheDocument();
    expect(screen.getByText('Improvement applied. Future work will use it.')).toBeInTheDocument();
  });

  it('rejects a suggestion and removes its decision actions', async () => {
    const ready = proposal('awaiting_approval');
    improvementsMock.mockResolvedValue([ready]);
    rejectImprovementMock.mockResolvedValue(proposal('rejected'));

    render(<PersonaImprovementsArea detail={detail} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Not for me' }));

    await waitFor(() => expect(rejectImprovementMock).toHaveBeenCalledWith(
      'jim',
      ready.id,
    ));
    expect(await screen.findByText('Not accepted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use this improvement' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not for me' })).not.toBeInTheDocument();
    expect(screen.getByText('Improvement declined.')).toBeInTheDocument();
  });

  it('undoes an active improvement and leaves a visible rolled-back state', async () => {
    const active = proposal('activated');
    improvementsMock.mockResolvedValue([active]);
    undoImprovementMock.mockResolvedValue(proposal('rolled_back'));

    render(<PersonaImprovementsArea detail={detail} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Undo improvement' }));

    await waitFor(() => expect(undoImprovementMock).toHaveBeenCalledWith(
      'jim',
      active.id,
    ));
    expect(await screen.findByText('Undone')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo improvement' })).not.toBeInTheDocument();
    expect(screen.getByText(
      'Improvement undone. Future work will use the earlier Behavior.',
    )).toBeInTheDocument();
  });

  it('saves an activated improvement as a reusable Role version after confirmation', async () => {
    const active = proposal('activated');
    const shared = proposal('activated', { promotedRoleVersionId: 'rolever_shared' });
    improvementsMock.mockResolvedValue([active]);
    promoteImprovementMock.mockResolvedValue({
      proposal: shared,
      roleVersion: { id: 'rolever_shared', name: 'Shared Role v2' },
    });

    render(<PersonaImprovementsArea detail={detail} />);

    fireEvent.click(await screen.findByRole('button', {
      name: 'Save as a reusable Role version',
    }));

    expect(screen.getByRole('heading', {
      name: 'Save improvement as a Role version',
    })).toBeInTheDocument();
    expect(screen.getByText(/saves a reviewed version of Developer/i)).toBeInTheDocument();
    expect(screen.getByText(/does not change any existing Persona/i)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Save Role version' });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox', {
      name: 'Why should this become the Role default?',
    }), {
      target: { value: 'Make the checked research pattern reusable for this Role.' },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(promoteImprovementMock).toHaveBeenCalledWith(
      'jim',
      active.id,
      {
        confirmation: 'PROMOTE',
        migrationNotes: 'Make the checked research pattern reusable for this Role.',
      },
    ));
    expect(await screen.findByText('Saved as Role version')).toBeInTheDocument();
    expect(screen.getByText(/Existing Personas and the current Role version have not changed/i))
      .toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Open Role history' })).toHaveAttribute(
      'href',
      expect.stringContaining('/roles/role_research'),
    );
    expect(screen.queryByRole('button', {
      name: 'Save as a reusable Role version',
    })).not.toBeInTheDocument();
  });
});
