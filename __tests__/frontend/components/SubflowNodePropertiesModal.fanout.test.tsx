/**
 * Component tests for the Subflow Node properties modal — dynamic fan-out
 * editors (issue #204, Phase 4 of #186).
 *
 * These assert the deterministic authoring contract for the four fan-out
 * fields that were previously read-only alerts:
 *  - parallelFlowsVariable  -> properties.parallelSubflowIdsVar (string)
 *  - mapOverList            -> properties.mapOverList (boolean, only `true`)
 *  - itemSplit              -> properties.itemSplit ('lines'; 'json-array' = absent)
 *  - sequential             -> properties.sequential (boolean, only `true`)
 *
 * Focus areas:
 *  - persistence: authored values land on properties with the right keys;
 *  - "never seed defaults" (#138): off/default/empty states REMOVE the key so
 *    UI output stays byte-compatible with the FlowSpec compiler;
 *  - mutual exclusion: the compiler's conflicting-mode error set is mirrored in
 *    the UI as disabled controls so an invalid combination can't be authored.
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
import SubflowNodePropertiesModal from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/SubflowNodePropertiesModal';

// The modal loads the list of selectable flows on open. It is irrelevant to
// these fan-out assertions — stub it to an empty list so no network is hit.
jest.mock('@/frontend/services/flow', () => ({
  flowService: { loadFlows: jest.fn().mockResolvedValue([]) },
}));

const makeNode = (properties: Record<string, any>): any => ({
  id: 'n1',
  type: 'subflow',
  position: { x: 0, y: 0 },
  data: { label: 'Subflow Node', type: 'subflow', properties },
});

/** Render the modal and capture the properties handed to onSave. */
const renderModal = (properties: Record<string, any>) => {
  const saved: { data: any } = { data: null };
  render(
    <SubflowNodePropertiesModal
      open
      node={makeNode(properties)}
      onClose={() => {}}
      onSave={(_id, data) => {
        saved.data = data;
      }}
      flowId="self"
    />,
  );
  return saved;
};

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

const mapCheckbox = () =>
  screen.getByRole('checkbox', {
    name: 'Run the selected flow once per input item (map over list)',
  });
const varField = () =>
  screen.getByRole('textbox', { name: 'Parallel flows from run variable' });

describe('SubflowNodePropertiesModal — dynamic fan-out editors (#204)', () => {
  it('renders editable fan-out controls (no longer read-only alerts)', async () => {
    renderModal({ subflowId: 'child-1' });
    expect(await screen.findByText('Dynamic fan-out')).toBeInTheDocument();
    expect(varField()).toBeInTheDocument();
    expect(mapCheckbox()).toBeInTheDocument();
    // The old "Configured via the flow API" map alert is gone.
    expect(screen.queryByText(/map-over-list, configured via the flow API/i)).not.toBeInTheDocument();
  });

  it('persists parallelSubflowIdsVar when a run-variable name is typed', async () => {
    const saved = renderModal({ subflowId: 'child-1' });
    await screen.findByText('Dynamic fan-out');
    fireEvent.change(varField(), { target: { value: '  targets  ' } });
    save();
    expect(saved.data.properties.parallelSubflowIdsVar).toBe('targets');
  });

  it('removes parallelSubflowIdsVar when the field is cleared (never store empty)', async () => {
    const saved = renderModal({ parallelSubflowIdsVar: 'targets' });
    await screen.findByText('Dynamic fan-out');
    expect(varField()).toHaveValue('targets');
    fireEvent.change(varField(), { target: { value: '' } });
    save();
    expect('parallelSubflowIdsVar' in saved.data.properties).toBe(false);
  });

  it('persists mapOverList:true and does NOT seed itemSplit/sequential', async () => {
    const saved = renderModal({ subflowId: 'child-1' });
    await screen.findByText('Dynamic fan-out');
    fireEvent.click(mapCheckbox());
    save();
    expect(saved.data.properties.mapOverList).toBe(true);
    expect('itemSplit' in saved.data.properties).toBe(false);
    expect('sequential' in saved.data.properties).toBe(false);
  });

  it('persists itemSplit=lines and sequential=true when explicitly set', async () => {
    const saved = renderModal({ subflowId: 'child-1' });
    await screen.findByText('Dynamic fan-out');
    fireEvent.click(mapCheckbox());
    // MUI Select: open the listbox then pick "Lines".
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Split input as' }));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Lines'));
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Run items one at a time (ignores max copies)' }),
    );
    save();
    expect(saved.data.properties.mapOverList).toBe(true);
    expect(saved.data.properties.itemSplit).toBe('lines');
    expect(saved.data.properties.sequential).toBe(true);
  });

  it('removes itemSplit when the default "JSON array" option is chosen', async () => {
    const saved = renderModal({ subflowId: 'child-1', mapOverList: true, itemSplit: 'lines' });
    await screen.findByText('Dynamic fan-out');
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Split input as' }));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('JSON array (default)'));
    save();
    expect(saved.data.properties.mapOverList).toBe(true);
    expect('itemSplit' in saved.data.properties).toBe(false);
  });

  it('cascade-removes itemSplit and sequential when map-over-list is turned off', async () => {
    const saved = renderModal({
      subflowId: 'child-1',
      mapOverList: true,
      itemSplit: 'lines',
      sequential: true,
    });
    await screen.findByText('Dynamic fan-out');
    fireEvent.click(mapCheckbox()); // uncheck
    save();
    expect('mapOverList' in saved.data.properties).toBe(false);
    expect('itemSplit' in saved.data.properties).toBe(false);
    expect('sequential' in saved.data.properties).toBe(false);
  });

  it('never seeds fan-out keys on an unrelated save (#138)', async () => {
    const saved = renderModal({ subflowId: 'child-1' });
    await screen.findByText('Dynamic fan-out');
    save(); // no fan-out control touched
    expect(saved.data.properties).toEqual({ subflowId: 'child-1' });
  });

  it('mirrors compiler mutual-exclusion: static parallel list disables var + map', async () => {
    renderModal({ parallelSubflowIds: ['a', 'b'] });
    await screen.findByText('Dynamic fan-out');
    expect(varField()).toBeDisabled();
    expect(mapCheckbox()).toBeDisabled();
  });

  it('mirrors compiler mutual-exclusion: parallel-var disables map-over-list', async () => {
    renderModal({ parallelSubflowIdsVar: 'targets' });
    await screen.findByText('Dynamic fan-out');
    expect(mapCheckbox()).toBeDisabled();
  });

  it('mirrors compiler mutual-exclusion: map-over-list disables the parallel-var field', async () => {
    renderModal({ subflowId: 'child-1', mapOverList: true });
    await screen.findByText('Dynamic fan-out');
    expect(varField()).toBeDisabled();
  });
});
