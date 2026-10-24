import type { TeamSummary } from '../../../../packages/shared-controller/src/teams';
import type { SharedResource, ResourceRevision, EditorLease } from '../../../../packages/shared-controller/src/team-resources';
export { modelConfigurationFields, publishableModel, readSharedModel, SHARED_MODEL_FORMAT } from '../../../../packages/shared-controller/src/shared-model';
export type { SharedModelDocument } from '../../../../packages/shared-controller/src/shared-model';
export { flowDependencies, projectSharedFlow, readSharedFlow, setFlowDependency, sharedFlowDocumentSchema, sharedFlowDraftSchema,
  sharedFlowNodeTypes, sharedFlowProperties, teamDependencyId, SHARED_FLOW_FORMAT } from '../../../../packages/shared-controller/src/shared-flow';
export type { SharedFlowDocument, FlowDependency } from '../../../../packages/shared-controller/src/shared-flow';
export type { TeamSummary, SharedResource, ResourceRevision, EditorLease };

export interface TeamResourceDetail {
  resource: SharedResource;
  revision: ResourceRevision;
  editor: { actorId: string; expiresAt: number } | null;
  history: Omit<ResourceRevision, 'content'>[];
}
export interface TeamResourceEdit { resource: SharedResource; revision: ResourceRevision; lease: EditorLease; }
export class TeamRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const root = '/_account/resources';
const address = (team: string, resource?: string) => `${root}?${new URLSearchParams({ team, ...(resource ? { resource } : {}) })}`;

async function request<T>(url: string, data?: Record<string, string | number>, keepalive = false): Promise<T> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { method: data ? 'POST' : 'GET', credentials: 'same-origin', redirect: 'error',
      cache: 'no-store', signal: controller.signal, keepalive,
      headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(data ? { body: new URLSearchParams(Object.entries(data).map(([key, value]) => [key, String(value)])) } : {}) });
    if (!response.headers.get('content-type')?.includes('application/json')) throw new TeamRequestError('The local team service is unavailable.', response.status);
    const result = await response.json();
    if (!response.ok) throw new TeamRequestError(typeof result?.error === 'string' ? result.error : 'The team request failed.', response.status);
    return result as T;
  } finally { clearTimeout(timer); }
}

const leaseFields = (teamId: string, resourceId: string, lease: EditorLease) => ({ teamId, resourceId, token: lease.token, fence: lease.fence });
export const teamService = {
  teams: () => request<{ teams: TeamSummary[] }>('/_account/teams'),
  resources: (teamId: string) => request<{ team: TeamSummary; resources: SharedResource[] }>(address(teamId)),
  read: (teamId: string, id: string) => request<TeamResourceDetail>(address(teamId, id)),
  acquire: (teamId: string, id: string, version: number) => request<TeamResourceEdit>(root, { action: 'edit', teamId, resourceId: id, version }),
  create: (teamId: string, name: string, content: string) => request<{ location: string }>(root,
    { action: 'create', teamId, kind: 'model', name, content, consent: 'share' }),
  createFlow: (teamId: string, name: string, content: string) => request<{ location: string }>(root,
    { action: 'create', teamId, kind: 'flow', name, content, consent: 'share' }),
  save: (teamId: string, id: string, lease: EditorLease, name: string, content: string) => request<{ location: string }>(root,
    { action: 'save', ...leaseFields(teamId, id, lease), version: lease.version, name, content }),
  renew: (teamId: string, id: string, lease: EditorLease) => request<{ expiresAt: number }>(root,
    { action: 'renew', ...leaseFields(teamId, id, lease) }),
  release: (teamId: string, id: string, lease: EditorLease) => request<{ location: string }>(root,
    { action: 'release', ...leaseFields(teamId, id, lease) }, true),
  historyUrl: address,
  accessUrl: (teamId: string, id: string) => `${address(teamId, id)}&access=1`,
};
