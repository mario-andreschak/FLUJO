import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import FlowCard from '@/frontend/components/Flow/FlowDashboard/FlowCard';
import type { Flow } from '@/frontend/types/flow/flow';

jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/CustomNodes', () => ({ getNodeColor: () => '#444' }));
jest.mock('@/frontend/components/shared/AllowanceBar', () => ({ __esModule: true, default: () => null }));
const flow: Flow = { id: `team-flow:${'t'.repeat(43)}:${'r'.repeat(43)}`, name: 'Shared agent', nodes: [], edges: [],
  teamFlow: { teamId: 't'.repeat(43), resourceId: 'r'.repeat(43), teamName: 'Offline team', version: 1, generation: 'a'.repeat(64) } };

it('routes shared edits to the team editor and exposes selection without private mutation actions', () => {
  const select = jest.fn(); const mutate = jest.fn();
  render(<ThemeProvider theme={createTheme()}><FlowCard flow={flow} selected={false} onSelect={select}
    onDelete={mutate} onCopy={mutate} onSetFolder={mutate} onToggleFavorite={mutate} onEdit={mutate} /></ThemeProvider>);
  expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', `/teams/flows?team=${flow.teamFlow!.teamId}&resource=${flow.teamFlow!.resourceId}`);
  expect(screen.getByText('Offline team')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /copy|delete|favorite|folder/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Shared agent')); expect(select).toHaveBeenCalledWith(flow.id); expect(mutate).not.toHaveBeenCalled();
});
