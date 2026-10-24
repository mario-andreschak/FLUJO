import React, { useState } from 'react';
import { deserialize, serialize } from 'node:v8';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import type { SharedFlowDocument, SharedResource } from '@/frontend/services/teams';

jest.mock('@xyflow/react', () => ({
  ConnectionMode: { Loose: 'loose' }, MarkerType: { ArrowClosed: 'arrowclosed' }, Background: () => null, Controls: () => null,
  ReactFlow: ({ nodes, onNodeClick }: { nodes: { id: string }[]; onNodeClick: (event: null, node: { id: string }) => void }) =>
    <div>{nodes.map(node => <button key={node.id} onClick={() => onNodeClick(null, node)}>Select {node.id}</button>)}</div>,
  applyNodeChanges: (_changes: unknown, nodes: unknown) => nodes,
}));
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/CustomNodes', () => ({ FlowQuickConnectEnabledContext: React.createContext(true) }));
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/CustomEdges', () => ({}));
import TeamFlowEditor from '@/frontend/components/Teams/TeamFlowEditor';

const priorClone = globalThis.structuredClone;
beforeAll(() => { globalThis.structuredClone = value => deserialize(serialize(value)); });
afterAll(() => { globalThis.structuredClone = priorClone; });
const teamId = 't'.repeat(43);
const initial: SharedFlowDocument = { format: 'flujo.flow.v1', flow: { name: 'Draft', nodes: ['first', 'second'].map(id => ({
  id, type: 'process', position: { x: 0, y: 0 }, data: { type: 'process', label: id, properties: { maxTurns: 5, boundModel: '' } },
})), edges: [] } };
const resources: SharedResource[] = [
  { id: 'a'.repeat(43), teamId, name: 'Eligible', kind: 'model', format: 'flujo.model.v1', creatorId: 'alice', version: 1, createdAt: 1 },
  { id: 'b'.repeat(43), teamId: 'x'.repeat(43), name: 'Foreign', kind: 'model', format: 'flujo.model.v1', creatorId: 'alice', version: 1, createdAt: 1 },
  { id: 'c'.repeat(43), teamId, name: 'Passive JSON', kind: 'model', format: 'json', creatorId: 'alice', version: 1, createdAt: 1 },
];
function Fixture() {
  const [value, onChange] = useState(initial); const [fields, setFields] = useState<Record<string, string>>({});
  return <ThemeProvider theme={createTheme()}><TeamFlowEditor value={value} teamId={teamId} resources={resources}
    disabled={false} onChange={onChange} onDraftFieldsChange={setFields} /><output data-testid="pending">{JSON.stringify(fields)}</output>
    <output data-testid="graph">{JSON.stringify(value)}</output></ThemeProvider>;
}

it('keeps invalid field text across selection changes and clears it when its property is removed', () => {
  render(<Fixture />); fireEvent.click(screen.getByRole('button', { name: 'Select first' }));
  const field = screen.getByLabelText('maxTurns'); fireEvent.change(field, { target: { value: 'unfinished[' } }); fireEvent.blur(field);
  expect(screen.getByTestId('pending')).toHaveTextContent('unfinished[');
  fireEvent.click(screen.getByRole('button', { name: 'Select second' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select first' }));
  expect(screen.getByLabelText('maxTurns')).toHaveValue('unfinished[');
  fireEvent.click(screen.getByRole('button', { name: 'Remove property: maxTurns' }));
  expect(screen.getByTestId('pending')).toHaveTextContent('{}'); expect(screen.queryByLabelText('maxTurns')).not.toBeInTheDocument();
});

it('clears unfinished fields for removed steps and restricts selectors to typed dependencies from this team', () => {
  render(<Fixture />); fireEvent.click(screen.getByRole('button', { name: 'Select first' }));
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Team dependency · model' }));
  expect(screen.getByRole('option', { name: 'Eligible · v1' })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /Foreign|Passive JSON/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('option', { name: 'Eligible · v1' }));
  expect(screen.getByTestId('graph')).toHaveTextContent(`team-model:${teamId}:${'a'.repeat(43)}`);
  fireEvent.change(screen.getByLabelText('maxTurns'), { target: { value: '{' } });
  fireEvent.click(screen.getByRole('button', { name: 'Remove selection' }));
  expect(screen.getByTestId('pending')).toHaveTextContent('{}'); expect(screen.queryByRole('button', { name: 'Select first' })).not.toBeInTheDocument();
});

it('edits temperature as a JSON number and can remove an optional dependency binding', () => {
  render(<Fixture />); fireEvent.click(screen.getByRole('button', { name: 'Select first' }));
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Property' }));
  fireEvent.click(screen.getByRole('option', { name: 'temperature' })); fireEvent.click(screen.getByRole('button', { name: 'Add property' }));
  const field = screen.getByLabelText('temperature'); expect(field).toHaveValue('0.7');
  fireEvent.change(field, { target: { value: '0.5' } }); fireEvent.blur(field);
  const graph = JSON.parse(screen.getByTestId('graph').textContent!);
  expect(graph.flow.nodes[0].data.properties.temperature).toBe(0.5);
  fireEvent.click(screen.getByRole('button', { name: 'Remove property: boundModel' }));
  expect(screen.queryByRole('combobox', { name: 'Team dependency · model' })).not.toBeInTheDocument();
});
