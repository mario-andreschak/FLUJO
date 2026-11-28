import { fireEvent, render, screen, within } from '@testing-library/react';
import McpServerDeleteDialog from '@/frontend/components/mcp/MCPServerManager/McpServerDeleteDialog';
import type { McpServerUsage } from '@/shared/types/mcp/serverUsage';

const servers = [
  { name: 'github-old' },
  { name: 'github-new' },
  { name: 'sleepy', disabled: true },
];

const usage: McpServerUsage = {
  serverName: 'github-old',
  uses: [
    { key: 'flow:triage', place: { kind: 'flow', flowId: 'triage', flowName: 'Triage', steps: 2 }, canRemove: true },
    { key: 'flow:jim-core', place: { kind: 'flow', flowId: 'jim-core', flowName: 'Jim Core', steps: 1, personaName: 'Jim' }, canRemove: true },
    { key: 'persona:jim:app', place: { kind: 'persona-app', personaId: 'jim', personaName: 'Jim' }, canRemove: true },
    {
      key: 'automation:poll:polls',
      place: { kind: 'automation', executionId: 'poll', automationName: 'Issue watch', role: 'polls', personaControlled: false },
      canRemove: true,
    },
  ],
};

function choose(group: string, option: string) {
  fireEvent.mouseDown(within(screen.getByRole('group', { name: group })).getByRole('combobox'));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

function optionsOf(group: string): (string | null)[] {
  fireEvent.mouseDown(within(screen.getByRole('group', { name: group })).getByRole('combobox'));
  const options = screen.getAllByRole('option').map((option) => option.textContent);
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
  return options;
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof McpServerDeleteDialog>> = {}) {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  render(
    <McpServerDeleteDialog
      usage={usage}
      servers={servers}
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

describe('McpServerDeleteDialog (#1389)', () => {
  it('names every place that still uses the app and deletes only once each has an answer', () => {
    const { onConfirm } = renderDialog();

    expect(screen.getByText('Delete “github-old”?')).toBeInTheDocument();
    expect(screen.getByText('Jim’s own copy of an agent')).toBeInTheDocument();
    const deleteButton = screen.getByRole('button', { name: 'Delete app' });
    expect(deleteButton).toBeDisabled();

    choose('Triage: Agent with 2 steps that use this app', 'github-new');
    choose('Jim Core: Agent with 1 step that uses this app', 'Leave the steps without an app for now');
    choose('Jim: Persona, Connected App', 'github-new');
    expect(deleteButton).toBeDisabled();
    choose('Issue watch: Automation that checks this app on a schedule', 'Turn the automation off');
    expect(deleteButton).toBeEnabled();

    fireEvent.click(deleteButton);
    expect(onConfirm).toHaveBeenCalledWith({
      choices: {
        'flow:triage': { replaceWith: 'github-new' },
        'flow:jim-core': { remove: true },
        'persona:jim:app': { replaceWith: 'github-new' },
        'automation:poll:polls': { remove: true },
      },
    });
  });

  it('never offers the app being deleted, and offers a Persona only apps that are on', () => {
    renderDialog();
    expect(optionsOf('Triage: Agent with 2 steps that use this app'))
      .toEqual(['github-new', 'sleepy', 'Leave the steps without an app for now']);
    expect(optionsOf('Jim: Persona, Connected App'))
      .toEqual(['github-new', 'Take the app away from Jim']);
  });

  it('warns plainly which places will stop using the app', () => {
    renderDialog();
    expect(screen.queryByText(/will stop using this app/)).not.toBeInTheDocument();
    choose('Jim: Persona, Connected App', 'Take the app away from Jim');
    expect(screen.getByText(/^Jim will stop using this app\./)).toBeInTheDocument();
  });

  it('shows why a delete did not happen and lets the person cancel', () => {
    const { onCancel } = renderDialog({ error: 'Could not change Persona "Jim".', notice: 'Something changed while this was open. Check the choices again.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not change Persona "Jim".');
    expect(screen.getByText('Something changed while this was open. Check the choices again.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('lets the person retry when nothing needs a choice', () => {
    const { onConfirm } = renderDialog({ usage: { serverName: 'notes', uses: [] }, error: 'Could not delete “notes”.' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete app' }));
    expect(onConfirm).toHaveBeenCalledWith({ choices: {} });
  });
});
