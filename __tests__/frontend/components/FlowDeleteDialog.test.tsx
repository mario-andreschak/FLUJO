import { fireEvent, render, screen, within } from '@testing-library/react';
import FlowDeleteDialog from '@/frontend/components/Flow/FlowDashboard/FlowDeleteDialog';
import type { Flow } from '@/frontend/types/flow/flow';
import type { FlowUsage } from '@/shared/types/flow/flowUsage';

const flow = (id: string, name: string, extra: Partial<Flow> = {}): Flow => ({ id, name, nodes: [], edges: [], ...extra });

const flows = [
  flow('research', 'Research'),
  flow('research-v2', 'Research v2'),
  flow('original', 'Original'),
  flow('jims-copy', 'Jim copy', { personaOwnership: { personaId: 'jim', groupId: 'g', kind: 'core' } } as Partial<Flow>),
];

const usage: FlowUsage = {
  flowId: 'research',
  flowName: 'Research',
  uses: [
    {
      key: 'persona:jim:core',
      place: { kind: 'persona-core', personaId: 'jim', personaName: 'Jim' },
      canRemove: true,
      removePauses: true,
    },
    {
      key: 'persona:ana:behavior:memory',
      place: { kind: 'persona-behavior', personaId: 'ana', personaName: 'Ana', behaviorRef: 'memory', behaviorName: 'Maintain memory', slotKey: 'maintain_memory' },
      canRemove: false,
      removePauses: false,
      suggestedFlowId: 'original',
    },
    {
      key: 'automation:daily:runs',
      place: { kind: 'automation', executionId: 'daily', automationName: 'Daily digest', role: 'runs', personaControlled: false },
      canRemove: true,
      removePauses: false,
    },
  ],
  copySources: [{ personaId: 'bo', personaName: 'Bo' }],
};

function choose(group: string, option: string) {
  fireEvent.mouseDown(within(screen.getByRole('group', { name: group })).getByRole('combobox'));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof FlowDeleteDialog>> = {}) {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  render(
    <FlowDeleteDialog
      usage={usage}
      flows={flows}
      busy={false}
      error={null}
      notice={null}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel };
}

describe('FlowDeleteDialog (#1389)', () => {
  it('names every place that still uses the agent and deletes only once each has an answer', () => {
    const { onConfirm } = renderDialog();

    expect(screen.getByText('Delete “Research”?')).toBeInTheDocument();
    expect(screen.getByText('Bo has its own copy of this agent and keeps working.')).toBeInTheDocument();
    const deleteButton = screen.getByRole('button', { name: 'Delete agent' });
    expect(deleteButton).toBeDisabled();

    choose('Jim: Persona, Core Flow', 'Research v2');
    expect(deleteButton).toBeDisabled();
    choose('Daily digest: Automation that runs this agent', 'Turn the automation off');
    expect(deleteButton).toBeEnabled();

    fireEvent.click(deleteButton);
    expect(onConfirm).toHaveBeenCalledWith({
      choices: {
        'persona:jim:core': { replaceWith: 'research-v2' },
        'persona:ana:behavior:memory': { replaceWith: 'original' },
        'automation:daily:runs': { remove: true },
      },
    });
  });

  it('offers only shared agents, suggests the original, and never offers removal for a Role part', () => {
    renderDialog();
    expect(screen.getByText('Ana needs this for its Role, so choose another agent.')).toBeInTheDocument();
    fireEvent.mouseDown(within(screen.getByRole('group', { name: 'Ana: Persona, behavior “Maintain memory”' })).getByRole('combobox'));
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Original (the original)', 'Research v2']);
  });

  it('warns plainly before pausing a Persona that loses its Core Flow', () => {
    renderDialog();
    expect(screen.queryByText(/will be paused/)).not.toBeInTheDocument();
    choose('Jim: Persona, Core Flow', 'Remove it and pause Jim');
    expect(screen.getByText('Jim will be paused. A paused Persona starts no new work until you give it a Core Flow and wake it up.'))
      .toBeInTheDocument();
  });

  it('shows why a delete did not happen and lets the person cancel', () => {
    const { onCancel } = renderDialog({ error: 'Persona "Jim" is working right now.', notice: 'Something changed while this was open. Check the choices again.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Persona "Jim" is working right now.');
    expect(screen.getByText('Something changed while this was open. Check the choices again.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
