import { fireEvent, render, screen, within } from '@testing-library/react';
import PackageUninstallDialog from '@/frontend/components/Packages/PackageUninstallDialog';
import type { Flow } from '@/frontend/types/flow/flow';
import type { PackageUsage } from '@/shared/types/package/uninstall';

const flow = (id: string, name: string): Flow => ({ id, name, nodes: [], edges: [] });

const usage: PackageUsage = {
  packageName: 'research-kit',
  flows: [{
    flowId: 'pkg-research',
    flowName: 'Research',
    uses: [{ key: 'persona:jim:core', place: { kind: 'persona-core', personaId: 'jim', personaName: 'Jim' }, canRemove: true, removePauses: true }],
    copySources: [],
  }],
  servers: [{
    serverName: 'pkg-search',
    uses: [{ key: 'flow:mine', place: { kind: 'flow', flowId: 'mine', flowName: 'My agent', steps: 1 }, canRemove: true }],
  }],
  leaving: { flowIds: ['pkg-research', 'pkg-helper'], serverNames: ['pkg-search'] },
};

function choose(group: string, option: string) {
  fireEvent.mouseDown(within(screen.getByRole('group', { name: group })).getByRole('combobox'));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

describe('PackageUninstallDialog (#1389)', () => {
  it('asks for each outside place, offers only what stays, and uninstalls once each has an answer', () => {
    const onConfirm = jest.fn();
    render(
      <PackageUninstallDialog
        usage={usage}
        flows={[flow('pkg-research', 'Research'), flow('pkg-helper', 'Helper'), flow('mine', 'My agent'), flow('other', 'Other research')]}
        servers={[{ name: 'pkg-search' }, { name: 'web' }]}
        busy={false}
        error={null}
        notice={null}
        onCancel={jest.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText('Uninstall “research-kit”?')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Agent “Research”' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Connected App “pkg-search”' })).toBeInTheDocument();
    const uninstall = screen.getByRole('button', { name: 'Uninstall' });
    expect(uninstall).toBeDisabled();

    fireEvent.mouseDown(within(screen.getByRole('group', { name: 'Jim: Persona, Core Flow' })).getByRole('combobox'));
    expect(screen.getAllByRole('option').map((option) => option.textContent))
      .toEqual(['My agent', 'Other research', 'Remove it and pause Jim']);
    fireEvent.click(screen.getByRole('option', { name: 'Other research' }));
    expect(uninstall).toBeDisabled();

    choose('My agent: Agent with 1 step that uses this app', 'Leave the steps without an app for now');
    expect(screen.getByText(/^My agent will stop using this app\./)).toBeInTheDocument();
    expect(uninstall).toBeEnabled();

    fireEvent.click(uninstall);
    expect(onConfirm).toHaveBeenCalledWith({
      flows: { 'pkg-research': { choices: { 'persona:jim:core': { replaceWith: 'other' } } } },
      servers: { 'pkg-search': { choices: { 'flow:mine': { remove: true } } } },
    });
  });
});
