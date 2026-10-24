import type { Flow } from './flow';
export const isTeamFlow = (flow: Pick<Flow, 'id' | 'teamFlow' | 'teamFlowBundle'>): boolean =>
  flow.id.startsWith('team-flow:') || flow.teamFlow !== undefined || flow.teamFlowBundle !== undefined;
export const teamFlowEditorUrl = (flow: Pick<Flow, 'id' | 'teamFlow'>): string => {
  const parts = /^team-flow:([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{43})$/.exec(flow.id);
  return parts ? `/teams/flows?${new URLSearchParams({ team: parts[1], resource: parts[2] })}` : '/teams/flows';
};
