import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { HarnessPolicySchema, HarnessTargetSchema } from '@/shared/types/harnessIntegration';
import { configureHarnessProfile, activateHarnessVersion, getHarnessProfile, listHarnessProfiles } from '@/backend/services/harness/profiles';
import { harnessTargetOptions } from '@/backend/services/harness/catalog';
import { getHarnessRun } from '@/backend/services/harness/service';
import { harnessQueueSummary, startHarnessWorker } from '@/backend/services/harness/worker';

export const HARNESS_TOOL_NAMES = ['list_harness_targets', 'configure_harness', 'read_harness_history', 'activate_harness_version'] as const;
export const isHarnessTool = (name: string) => (HARNESS_TOOL_NAMES as readonly string[]).includes(name);
export function harnessToolDefinitions(): Tool[] {
  return [
    { name: 'list_harness_targets', description: 'List saved agent steps and Persona behaviors eligible for versioned Harness²-style improvement. Includes current improvement profile IDs and settings.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'configure_harness', description: 'Configure an explicitly selected agent or Persona behavior for unattended instruction improvement after conversations. automatic=true authorizes bounded proposals, replay evaluation and activation of passing revisions; false disables it. Preserve the exact target and expectedUpdatedAt returned by inspection. Model/provider permissions remain enforced.', inputSchema: { type: 'object', properties: {
      target: z.toJSONSchema(HarnessTargetSchema), policy: z.toJSONSchema(HarnessPolicySchema), expectedUpdatedAt: { type: 'number' },
    }, required: ['target', 'policy'], additionalProperties: false } },
    { name: 'read_harness_history', description: 'Read immutable agent/Persona prompt versions, active identity, activation events, queue and optional experiment evidence before changing a version.', inputSchema: { type: 'object', properties: { profileId: { type: 'string' }, experimentId: { type: 'string' } }, required: ['profileId'], additionalProperties: false } },
    { name: 'activate_harness_version', description: 'Activate any retained version belonging to this agent/Persona target, including rollback or forward restoration. Requires expectedUpdatedAt from a fresh read. Pauses automatic improvement so it cannot immediately undo this choice. In-flight conversations keep their snapshots.', inputSchema: { type: 'object', properties: { profileId: { type: 'string' }, versionId: { type: 'string' }, expectedUpdatedAt: { type: 'number' } }, required: ['profileId', 'versionId', 'expectedUpdatedAt'], additionalProperties: false } },
  ];
}
export async function callHarnessTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  let result: unknown;
  if (name === 'list_harness_targets') {
    z.object({}).strict().parse(args);
    result = { targets: await harnessTargetOptions(), profiles: (await listHarnessProfiles()).map(profile => ({ id: profile.id,
      target: profile.target, policy: profile.policy, updatedAt: profile.updatedAt, activeVersionId: profile.activeVersionId })) };
  } else if (name === 'configure_harness') {
    const input = z.object({ target: HarnessTargetSchema, policy: HarnessPolicySchema, expectedUpdatedAt: z.number().optional() }).strict().parse(args);
    const profile = await configureHarnessProfile(input.target, input.policy, input.expectedUpdatedAt);
    startHarnessWorker(); result = { profileId: profile.id, updatedAt: profile.updatedAt, policy: profile.policy };
  } else if (name === 'activate_harness_version') {
    const input = z.object({ profileId: z.string().regex(/^[a-f0-9]{64}$/), versionId: z.string().regex(/^[a-f0-9]{64}$/), expectedUpdatedAt: z.number() }).strict().parse(args);
    const profile = await activateHarnessVersion(input.profileId, input.versionId, input.expectedUpdatedAt);
    result = { profileId: profile.id, updatedAt: profile.updatedAt, activeVersionId: profile.activeVersionId, automatic: profile.policy.automatic };
  } else {
    const input = z.object({ profileId: z.string().regex(/^[a-f0-9]{64}$/), experimentId: z.uuid().optional() }).strict().parse(args);
    const profile = await getHarnessProfile(input.profileId);
    if (!profile) throw new Error('Harness profile not found.');
    const experiment = input.experimentId ? await getHarnessRun(input.experimentId) : undefined;
    if (experiment && experiment.profileId !== profile.id) throw new Error('Experiment does not belong to this target.');
    result = { ...profile, versions: profile.versions.map(({ flow: _flow, ...version }) => { void _flow; return version; }),
      queue: await harnessQueueSummary(profile.id), experiment };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}
