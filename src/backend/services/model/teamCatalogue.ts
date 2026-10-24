import { request } from 'node:http';
import type { Model } from '@/shared/types/model';
import { parseTeamModelId, resolvedTeamModelSchema, teamModelBaseUrl, teamModelCatalogueSchema,
  teamModelId, type TeamModelReference } from '../../../../packages/shared-controller/src/shared-model';

const controllerRuntime = () => process.env.FLUJO_CONTAINER === '1'
  && process.env.FLUJO_OWNER_AUTH_FILE === '/run/flujo-owner/owner.json';
const message = 'Shared models are unavailable. Check the local team execution permission and retry.';

/** Fixed loopback only. No proxy environment, redirects, cookies, credentials,
 * caller-selected host or fallback to a private model. */
function read(path: string, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const outgoing = request(`http://127.0.0.1:4290${path}`, { method: 'GET', agent: false, signal,
      maxHeaderSize: 8192, headers: { Accept: 'application/json' } }, response => {
      if (response.statusCode !== 200 || response.headers['content-type']?.split(';')[0] !== 'application/json') {
        response.destroy(); reject(new Error(message)); return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { response.destroy(new Error(message)); return; }
        chunks.push(chunk);
      });
      response.once('error', () => reject(new Error(message)));
      response.once('end', () => {
        try { if (!response.complete) throw new Error(message); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error(message)); }
      });
    });
    outgoing.once('error', () => reject(new Error(message))); outgoing.end();
  });
}

function project(reference: TeamModelReference, model: Partial<Model> & { name: string }): Model {
  return { ...model, id: teamModelId(reference), name: model.name,
    displayName: `${model.displayName || model.name} · ${reference.teamName}`,
    ApiKey: '', provider: 'ollama', adapter: 'openai', baseUrl: teamModelBaseUrl(reference), teamModel: reference };
}

export async function listTeamModels(): Promise<{ models: Model[]; unavailable: boolean }> {
  if (!controllerRuntime()) return { models: [], unavailable: false };
  const models: Model[] = []; let after: string | null = null; let size = 0;
  const signal = AbortSignal.timeout(20_000); const ids = new Set<string>();
  try {
    do {
      const page = teamModelCatalogueSchema.parse(await read(`/teams/models${after ? `/after/${after}` : ''}`, signal));
      for (const entry of page.entries) {
        if ((after && entry.reference.resourceId <= after) || ids.has(entry.reference.resourceId)) throw new Error(message);
        ids.add(entry.reference.resourceId);
        const model = project(entry.reference, entry.model); size += Buffer.byteLength(JSON.stringify(model));
        if (size > 32 * 1024 * 1024) throw new Error(message);
        models.push(model);
      }
      if (page.next && after && page.next <= after) throw new Error(message);
      after = page.next;
    } while (after);
    return { models, unavailable: false };
  } catch { return { models: [], unavailable: true }; }
}

export async function resolveTeamModel(id: string): Promise<Model> {
  const identity = parseTeamModelId(id);
  if (!controllerRuntime() || !identity) throw new Error(message);
  const result = resolvedTeamModelSchema.parse(await read(`/teams/${identity.teamId}/${identity.resourceId}/current`, AbortSignal.timeout(10_000)));
  if (teamModelId(result.reference) !== id) throw new Error(message);
  return project(result.reference, result.document.model);
}
