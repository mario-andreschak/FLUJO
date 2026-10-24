import type { Model } from './model';
import { parseTeamModelId, teamModelBaseUrl, teamModelReferenceSchema } from '../../../../packages/shared-controller/src/shared-model';

/** A marker only, never authorization. Every send is authorized by the owner pipe. */
export const isTeamModel = (model: Pick<Model, 'id' | 'teamModel'>): boolean =>
  (typeof model.id === 'string' && model.id.startsWith('team-model:')) || model.teamModel !== undefined;
/** Inert SDK construction value. It is ignored by the loopback relay and is
 * never an upstream token, browser credential or permission to execute. */
export function teamModelTransportKey(model: Model): string {
  const identity = parseTeamModelId(model.id); const reference = teamModelReferenceSchema.parse(model.teamModel);
  if (!identity || identity.teamId !== reference.teamId || identity.resourceId !== reference.resourceId
    || model.baseUrl !== teamModelBaseUrl(reference) || model.provider !== 'ollama' || model.adapter !== 'openai'
    || model.ApiKey !== '' || model.ownerCredentialBinding || model.fallbackPolicy) {
    throw new Error('Shared model transport configuration is invalid. Reload the current team model.');
  }
  return 'flujo-local-team-relay';
}
