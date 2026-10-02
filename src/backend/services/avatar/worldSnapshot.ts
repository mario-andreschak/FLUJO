import { modelService } from '@/backend/services/model';
import { flowService } from '@/backend/services/flow';
import { mcpService } from '@/backend/services/mcp';
import { getSchedulerService } from '@/backend/services/scheduler';
import { listPersonaSummaries } from '@/backend/services/enduringAgents/personaSummary';
import { listMeetingSummaries } from '@/backend/services/meetings/store';
import { readAvatarWorkModel } from './workModel';
import { listAllRunResources } from '@/backend/services/runResources';
import type { AvatarWorldObject, AvatarWorldSnapshot } from '@/shared/types/avatar';

/** Bounded, passive presentation of existing entities. No credentials, prompts,
 * tool arguments, goals, or memories are included in the scene snapshot. */
export async function getAvatarWorldSnapshot(): Promise<AvatarWorldSnapshot> {
  const unavailable: string[] = [];
  const truncated: string[] = [];
  const objects: AvatarWorldObject[] = [];
  const limit = (kind: string, items: AvatarWorldObject[]) => {
    if (items.length > 50) truncated.push(kind);
    objects.push(...items.slice(0, 50));
  };
  let workModel: AvatarWorldSnapshot['workModel'] = null;
  const sections = await Promise.allSettled([
    modelService.loadModels().then(async models => { workModel = await readAvatarWorkModel(models); }),
    flowService.listFlows().then(result => {
      if (!result.success) throw new Error('Unavailable');
      limit('flows', (result.flows ?? []).map(flow => ({ id: flow.id, name: flow.name, kind: 'flow', state: 'saved', href: `/flows?flow=${encodeURIComponent(flow.id)}` })));
    }),
    mcpService.loadServerConfigs().then(configs => {
      if (!Array.isArray(configs)) throw new Error('Unavailable');
      limit('apps', configs.map(config => ({ id: config.name, name: config.name, kind: 'app', state: config.disabled ? 'disabled' : 'configured', href: `/mcp?server=${encodeURIComponent(config.name)}` })));
    }),
    listPersonaSummaries({ pageSize: 50 }).then(page => {
      if (page.hasMore) truncated.push('personas');
      limit('personas', page.items.map(persona => ({ id: persona.id, name: persona.name, kind: 'persona', state: persona.status, canTalk: persona.capabilities.talk, href: `/personas/${encodeURIComponent(persona.id)}` })));
    }),
    getSchedulerService().list().then(entries => limit('automations', entries.map(({ execution, status }) => ({ id: execution.id, name: execution.name, kind: 'automation', state: status.lastTriggerError ? 'error' : status.running ? 'running' : status.armed ? 'armed' : status.notArmedReason || 'inactive', href: '/automation/triggers' })))),
    listMeetingSummaries().then(meetings => limit('meetings', meetings.map(meeting => ({ id: meeting.id, name: meeting.title, kind: 'meeting', state: meeting.status, href: `/meetings?meeting=${encodeURIComponent(meeting.id)}` })))),
    listAllRunResources(51).then(resources => limit('artifacts', resources.filter(resource => !['tool-args', 'compaction-artifact'].includes(resource.producedBy.source)).map(resource => ({
      id: `${resource.conversationId}:${resource.id}`, name: resource.name || resource.kind, kind: 'artifact', state: resource.kind,
      href: `/chat?conversation=${encodeURIComponent(resource.conversationId)}`,
      resource: { conversationId: resource.conversationId, id: resource.id, kind: resource.kind, mimeType: resource.mimeType, size: resource.size, createdAt: resource.createdAt },
    })))),
  ]);
  sections.forEach((section, index) => { if (section.status === 'rejected') unavailable.push(['models', 'flows', 'apps', 'personas', 'automations', 'meetings', 'artifacts'][index]); });
  return { checkedAt: Date.now(), workModel, objects: objects.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)), unavailable, truncated };
}
