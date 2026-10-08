import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';

export function personaReturnPath(personaId: string): string {
  return `/personas/${encodeURIComponent(personaId)}?area=setup&section=behaviors`;
}

/** Canonical workspace-aware Flow Builder link used by all Persona entry points. */
export function personaFlowBuilderUrl(flowRef: string, returnTo?: string): string {
  const query = new URLSearchParams({ flow: flowRef, mode: 'edit' });
  if (returnTo) query.set('returnTo', returnTo);
  return withWorkspaceUrl(`/flows?${query.toString()}`);
}
