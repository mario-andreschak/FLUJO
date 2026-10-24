import { request } from 'node:http';
import type { Flow } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import { hashFlowExecutionSnapshot } from './executionSnapshot';
import { assertTeamFlowCapabilities, flowDependencies, parseTeamFlowId, readSharedFlow, teamFlowBundleSchema,
  teamFlowCatalogueSchema, teamFlowId, teamFlowReferenceSchema, TEAM_FLOW_BUNDLE_BYTES,
  type TeamFlowBundle, type TeamFlowReference } from '../../../../packages/shared-controller/src/shared-flow';

const enabled = () => process.env.FLUJO_CONTAINER === '1' && process.env.FLUJO_OWNER_AUTH_FILE === '/run/flujo-owner/owner.json';
export class TeamFlowUnavailableError extends Error {
  constructor() { super('Shared Flows are unavailable or their execution permission changed. Check Team Flows and retry.'); this.name = 'TeamFlowUnavailableError'; }
}
function read(path: string, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const outgoing = request(`http://127.0.0.1:4290${path}`, { method: 'GET', agent: false, signal, maxHeaderSize: 8192,
      headers: { Accept: 'application/json' } }, response => {
      if (response.statusCode !== 200 || response.headers['content-type']?.split(';')[0] !== 'application/json') {
        response.destroy(); reject(new TeamFlowUnavailableError()); return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > TEAM_FLOW_BUNDLE_BYTES) { response.destroy(new TeamFlowUnavailableError()); return; }
        chunks.push(chunk);
      });
      response.once('error', () => reject(new TeamFlowUnavailableError()));
      response.once('end', () => {
        try { if (!response.complete) throw new TeamFlowUnavailableError(); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new TeamFlowUnavailableError()); }
      });
    });
    outgoing.once('error', () => reject(new TeamFlowUnavailableError())); outgoing.end();
  });
}

/** Revalidate the DTO even on restored local state. Only the controller decides
 * current membership/grants; this structural check is not an authority claim. */
export function validateTeamFlowBundle(value: unknown): TeamFlowBundle {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > TEAM_FLOW_BUNDLE_BYTES) throw new TeamFlowUnavailableError();
  const bundle = teamFlowBundleSchema.parse(value); const { reference } = bundle;
  const resources = new Map(bundle.flows.map(item => [item.resourceId, item]));
  const models = new Map(bundle.models.map(item => [item.resourceId, item]));
  if (resources.size !== bundle.flows.length || models.size !== bundle.models.length
    || resources.get(reference.resourceId)?.version !== reference.version
    || bundle.models.some(item => item.teamId !== reference.teamId)) throw new TeamFlowUnavailableError();
  const visited = new Set<string>(); const usedModels = new Set<string>(); let visits = 0;
  const visit = (id: string, path: string[]): void => {
    if (path.includes(id) || path.length > 8 || ++visits > 4096) throw new TeamFlowUnavailableError();
    const item = resources.get(id); if (!item) throw new TeamFlowUnavailableError();
    const document = readSharedFlow(item.document, reference.teamId); assertTeamFlowCapabilities(document); visited.add(id);
    for (const dependency of flowDependencies(document)) {
      const target = dependency.value.split(':')[2];
      if (dependency.kind === 'flow') visit(target, [...path, id]);
      else if (dependency.kind === 'model') { if (!models.has(target)) throw new TeamFlowUnavailableError(); usedModels.add(target); }
      else throw new TeamFlowUnavailableError();
    }
  };
  visit(reference.resourceId, []);
  if (visited.size !== resources.size || usedModels.size !== models.size) throw new TeamFlowUnavailableError();
  return bundle;
}
export function projectTeamFlow(bundle: TeamFlowBundle, resourceId = bundle.reference.resourceId, options: { includeBundle?: boolean } = {}): Flow {
  const item = bundle.flows.find(entry => entry.resourceId === resourceId); if (!item) throw new TeamFlowUnavailableError();
  return { ...structuredClone(item.document.flow), id: teamFlowId({ teamId: bundle.reference.teamId, resourceId }),
    name: `${item.document.flow.name} · ${bundle.reference.teamName}`, teamFlow: structuredClone(bundle.reference),
    ...(options.includeBundle === false ? {} : { teamFlowBundle: structuredClone(bundle) }) };
}
export async function resolveTeamFlowBundle(id: string): Promise<TeamFlowBundle> {
  const identity = parseTeamFlowId(id); if (!enabled() || !identity) throw new TeamFlowUnavailableError();
  try {
    const bundle = validateTeamFlowBundle(await read(`/teams/flows/${identity.teamId}/${identity.resourceId}/current`, AbortSignal.timeout(10_000)));
    if (teamFlowId(bundle.reference) !== id) throw new TeamFlowUnavailableError();
    return bundle;
  } catch { throw new TeamFlowUnavailableError(); }
}
export async function resolveTeamFlow(id: string): Promise<Flow> { return projectTeamFlow(await resolveTeamFlowBundle(id)); }
export async function assertTeamFlowCurrent(reference: TeamFlowReference, signal?: AbortSignal): Promise<void> {
  if (!enabled()) throw new TeamFlowUnavailableError();
  const checked = teamFlowReferenceSchema.parse(reference);
  const response = await read(`/teams/flows/${checked.teamId}/${checked.resourceId}/current/${checked.generation}`,
    signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000));
  const actual = teamFlowReferenceSchema.parse((response as { reference?: unknown }).reference);
  if (JSON.stringify(actual) !== JSON.stringify(checked)) throw new TeamFlowUnavailableError();
}
export function assertTeamFlowSnapshot(flow: Flow, bundle: TeamFlowBundle): void {
  const identity = parseTeamFlowId(flow.id);
  if (!identity || identity.teamId !== bundle.reference.teamId
    || hashFlowExecutionSnapshot(flow) !== hashFlowExecutionSnapshot(projectTeamFlow(bundle, identity.resourceId))) throw new TeamFlowUnavailableError();
}
/** Pin preparation to the grant admitted with the graph, before any prompt or tool work. */
export function assertTeamFlowModel(flow: Flow | undefined, model: Model): void {
  if (!flow?.teamFlow) return;
  const reference = model.teamModel;
  const expected = flow.teamFlowBundle?.models.find(item => item.resourceId === reference?.resourceId);
  if (!reference || !expected || reference.teamId !== expected.teamId || reference.version !== expected.version
    || reference.generation !== expected.generation) throw new TeamFlowUnavailableError();
}
export function pinnedTeamSubflow(parent: Flow, nodeId: string, childId: string): Flow {
  const bundle = validateTeamFlowBundle(parent.teamFlowBundle); assertTeamFlowSnapshot(parent, bundle);
  const identity = parseTeamFlowId(childId);
  const document = bundle.flows.find(item => item.resourceId === parseTeamFlowId(parent.id)?.resourceId)?.document;
  if (!identity || identity.teamId !== bundle.reference.teamId || !document
    || !flowDependencies(document).some(slot => slot.nodeId === nodeId && slot.kind === 'flow' && slot.value === childId)) throw new TeamFlowUnavailableError();
  return projectTeamFlow(bundle, identity.resourceId);
}
export async function listTeamFlows(): Promise<{ flows: Flow[]; unavailable: boolean }> {
  if (!enabled()) return { flows: [], unavailable: false };
  const flows: Flow[] = []; const seen = new Set<string>(); let after: string | null = null; let bytes = 0;
  const signal = AbortSignal.timeout(20_000);
  try {
    do {
      const page = teamFlowCatalogueSchema.parse(await read(`/teams/flows${after ? `/after/${after}` : ''}`, signal));
      for (const entry of page.entries) {
        const id = teamFlowId(entry.reference);
        if (seen.has(id) || (after && entry.reference.resourceId <= after)) throw new TeamFlowUnavailableError(); seen.add(id);
        const flow: Flow = { id, name: `${entry.name} · ${entry.reference.teamName}`, description: entry.description,
          nodes: [], edges: [], teamFlow: entry.reference };
        bytes += Buffer.byteLength(JSON.stringify(flow)); if (bytes > 16 * 1024 * 1024) throw new TeamFlowUnavailableError(); flows.push(flow);
      }
      if (page.next && after && page.next <= after) throw new TeamFlowUnavailableError(); after = page.next;
    } while (after);
    return { flows, unavailable: false };
  } catch { return { flows: [], unavailable: true }; }
}
