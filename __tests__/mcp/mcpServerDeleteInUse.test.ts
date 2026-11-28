/**
 * Deleting a Connected App (MCP server) that flows, Personas or automations
 * still use (#1389). Each place gets the person's answer first (another app,
 * or giving the app up), and the app is deleted last, so nothing points at an
 * app that is gone, even when the work stops part-way.
 */
import type { MCPServerConfig } from '@/shared/types/mcp';
import type { Flow } from '@/shared/types/flow';
import type { PlannedExecution } from '@/shared/types/plannedExecution';

const configs: MCPServerConfig[] = [];
jest.mock('@/backend/services/mcp/config', () => {
  const actual = jest.requireActual('@/backend/services/mcp/config');
  return { ...actual, loadServerConfigs: async () => configs.map((config) => ({ ...config })) };
});

const executions: PlannedExecution[] = [];
jest.mock('@/backend/services/scheduler', () => {
  const actual = jest.requireActual('@/backend/services/scheduler');
  const scheduler = {
    listConfigs: async () => executions.map((execution) => structuredClone(execution)),
    get: async (id: string) => executions.find((execution) => execution.id === id) ?? null,
    update: async (id: string, patch: Partial<PlannedExecution>) => {
      const index = executions.findIndex((execution) => execution.id === id);
      if (index < 0) return { error: `No planned execution with id "${id}"` };
      executions[index] = { ...executions[index], ...patch };
      return { execution: executions[index] };
    },
  };
  return { ...actual, getSchedulerService: () => scheduler };
});
jest.mock('@/backend/services/enduringAgents/store', () => {
  const actual = jest.requireActual('@/backend/services/enduringAgents/store');
  return { ...actual, deletePersonaAppGrantRecord: jest.fn(actual.deletePersonaAppGrantRecord) };
});
jest.mock('@/backend/services/enduringAgents/personaAppGrants', () => {
  const actual = jest.requireActual('@/backend/services/enduringAgents/personaAppGrants');
  return { ...actual, releasePersonaApp: jest.fn(actual.releasePersonaApp) };
});

import { flowService } from '@/backend/services/flow';
import { mcpService } from '@/backend/services/mcp';
import { deleteMcpServerAndMoveUses, findMcpServerUsage } from '@/backend/services/mcp/serverDeletion';
import { grantPersonaAppAccess, releasePersonaApp } from '@/backend/services/enduringAgents/personaAppGrants';
import { readPersonaComposition } from '@/backend/services/enduringAgents/personaComposition';
import {
  deletePersonaAppGrantRecord,
  getPersona,
  listPersonaAppGrants,
} from '@/backend/services/enduringAgents/store';
import { runWithWorkspace } from '@/utils/workspace';
import { createPersonaFromRole } from '../enduringAgents/fixtures/personaFactory';

jest.setTimeout(120_000);

jest.spyOn(mcpService, 'deleteServerConfig').mockImplementation(async (name: string) => {
  const index = configs.findIndex((config) => config.name === name);
  if (index < 0) return { success: false, error: `Server ${name} not found` };
  configs.splice(index, 1);
  return { success: true };
});

const server = (name: string, disabled = false): MCPServerConfig => ({
  name,
  transport: 'stdio',
  command: 'node',
  args: [],
  env: {},
  disabled,
  rootPath: '',
  _buildCommand: '',
  _installCommand: '',
} as MCPServerConfig);

let sequence = 0;
function isolated(task: () => Promise<void>) {
  return runWithWorkspace(`mcp-delete-in-use-${process.pid}-${++sequence}`, async () => {
    executions.length = 0;
    configs.length = 0;
    configs.push(server('github-old'), server('github-new'), server('notes'), server('sleepy', true));
    await task();
  });
}

function flowUsing(id: string, name: string, serverName: string, label = serverName): Flow {
  return {
    id,
    name,
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start', type: 'start', properties: {} } },
      { id: 'ask', type: 'process', position: { x: 240, y: 0 }, data: { label: 'Ask', type: 'process', properties: { promptTemplate: 'Do it.' } } },
      {
        id: 'app',
        type: 'mcp',
        position: { x: 240, y: 200 },
        data: { label, type: 'mcp', properties: { boundServer: serverName, enabledTools: ['list_issues'] } },
      },
      { id: 'finish', type: 'finish', position: { x: 480, y: 0 }, data: { label: 'Finish', type: 'finish', properties: {} } },
    ],
    edges: [
      { id: 'start-ask', source: 'start', target: 'ask' },
      { id: 'ask-app', source: 'ask', target: 'app' },
      { id: 'ask-finish', source: 'ask', target: 'finish' },
    ],
  } as Flow;
}

async function saveFlowUsing(id: string, name: string, serverName: string, label?: string): Promise<void> {
  expect((await flowService.saveFlow(flowUsing(id, name, serverName, label))).success).toBe(true);
}

/** A Persona with the app granted, with one tool chosen. */
async function personaWithApp(name: string, serverName: string): Promise<string> {
  const bundle = await createPersonaFromRole({ name, idempotencyKey: `persona-${name}` });
  await grantPersonaAppAccess(bundle.persona.id, { mcpServerName: serverName, enabledTools: ['list_issues'] });
  return bundle.persona.id;
}

function pollingAutomation(id: string, name: string, serverName: string, enabled = true): PlannedExecution {
  return {
    id,
    name,
    prompt: '',
    enabled,
    flowId: 'none',
    trigger: { type: 'mcp-poll', serverName, toolName: 'list_issues', args: {}, cron: '*/5 * * * *', evaluate: { mode: 'any-change' } },
  } as unknown as PlannedExecution;
}

async function appStep(flowId: string): Promise<{ label: string; properties: Record<string, unknown> }> {
  const data = (await flowService.getFlow(flowId))!.nodes.find((node) => node.id === 'app')!.data;
  return { label: data.label, properties: data.properties ?? {} };
}

describe('deleting a Connected App that is still used', () => {
  afterEach(() => jest.clearAllMocks());

  it('deletes an unused app at once, as before', () => isolated(async () => {
    const outcome = await deleteMcpServerAndMoveUses('notes', null, null);

    expect(outcome.status).toBe('deleted');
    expect(configs.map((config) => config.name)).not.toContain('notes');
  }));

  it('lists every place and changes nothing when no choice was sent', () => isolated(async () => {
    await saveFlowUsing('triage', 'Triage', 'github-old');
    const personaId = await personaWithApp('Jim', 'github-old');
    executions.push(
      pollingAutomation('poll', 'Issue watch', 'github-old'),
      pollingAutomation('off', 'Old watch', 'github-old', false),
    );

    const outcome = await deleteMcpServerAndMoveUses('github-old', null, null);

    expect(outcome).toMatchObject({ status: 'in-use', changed: false });
    if (outcome.status !== 'in-use') throw new Error('expected in-use');
    expect(outcome.usage.uses.map((use) => use.place)).toEqual([
      { kind: 'persona-app', personaId, personaName: 'Jim' },
      { kind: 'flow', flowId: 'triage', flowName: 'Triage', steps: 1 },
      { kind: 'automation', executionId: 'poll', automationName: 'Issue watch', role: 'polls', personaControlled: false },
    ]);
    expect(configs.map((config) => config.name)).toContain('github-old');
    expect((await appStep('triage')).properties.boundServer).toBe('github-old');
  }));

  it('switches every place to another app, keeping tool choices, then deletes', () => isolated(async () => {
    await saveFlowUsing('triage', 'Triage', 'github-old');
    const personaId = await personaWithApp('Jim', 'github-old');
    executions.push(pollingAutomation('poll', 'Issue watch', 'github-old'));
    const usage = (await findMcpServerUsage('github-old'))!;

    const outcome = await deleteMcpServerAndMoveUses('github-old', {
      choices: Object.fromEntries(usage.uses.map((use) => [use.key, { replaceWith: 'github-new' }])),
    }, null);

    expect(outcome).toMatchObject({
      status: 'deleted',
      summary: { flows: ['Triage'], personas: ['Jim'], automations: ['Issue watch'], turnedOffAutomations: [] },
    });
    expect(configs.map((config) => config.name)).not.toContain('github-old');
    expect(await appStep('triage')).toMatchObject({
      label: 'github-new',
      properties: { boundServer: 'github-new', enabledTools: ['list_issues'] },
    });
    expect((await listPersonaAppGrants(personaId)).map((grant) => [grant.mcpServerName, grant.enabledTools]))
      .toEqual([['github-new', ['list_issues']]]);
    expect((await getPersona(personaId))!.composition?.appRefs).toEqual(['github-new']);
    expect(executions[0].trigger).toMatchObject({ type: 'mcp-poll', serverName: 'github-new' });
    expect(executions[0].enabled).toBe(true);
    expect((await readPersonaComposition(personaId))!.appIssues).toBeUndefined();
  }));

  it('takes the app away where asked: steps are left without an app, the Persona loses it, the automation is turned off', () => isolated(async () => {
    await saveFlowUsing('triage', 'Triage', 'github-old');
    await saveFlowUsing('custom', 'Custom', 'github-old', 'My issue reader');
    const personaId = await personaWithApp('Jim', 'github-old');
    executions.push(pollingAutomation('poll', 'Issue watch', 'github-old'));
    const usage = (await findMcpServerUsage('github-old'))!;

    const outcome = await deleteMcpServerAndMoveUses('github-old', {
      choices: Object.fromEntries(usage.uses.map((use) => [use.key, { remove: true }])),
    }, null);

    expect(outcome).toMatchObject({ status: 'deleted', summary: { turnedOffAutomations: ['Issue watch'] } });
    const triage = await appStep('triage');
    expect(triage.label).toBe('MCP Node');
    expect(triage.properties).not.toHaveProperty('boundServer');
    expect(triage.properties).not.toHaveProperty('enabledTools');
    expect((await appStep('custom')).label).toBe('My issue reader');
    expect(await listPersonaAppGrants(personaId)).toEqual([]);
    expect((await getPersona(personaId))!.composition?.appRefs).toEqual([]);
    expect(executions[0]).toMatchObject({ enabled: false, trigger: { serverName: 'github-old' } });
  }));

  it('keeps the app when the work stops halfway; the places already switched stay switched and the next delete asks only about the rest', () => isolated(async () => {
    await saveFlowUsing('triage', 'Triage', 'github-old');
    const personaId = await personaWithApp('Jim', 'github-old');
    const usage = (await findMcpServerUsage('github-old'))!;
    const plan = { choices: Object.fromEntries(usage.uses.map((use) => [use.key, { replaceWith: 'github-new' }])) };
    jest.mocked(releasePersonaApp).mockRejectedValueOnce(new Error('the computer went to sleep'));

    const stopped = await deleteMcpServerAndMoveUses('github-old', plan, null);

    expect(stopped).toMatchObject({ status: 'refused' });
    if (stopped.status !== 'refused') throw new Error('expected refused');
    expect(stopped.error).toMatch(/Persona "Jim".*The app was not deleted\. Places that were already switched stay switched\./);
    expect(configs.map((config) => config.name)).toContain('github-old');
    expect((await appStep('triage')).properties.boundServer).toBe('github-new');
    expect((await findMcpServerUsage('github-old'))!.uses.map((use) => use.place.kind)).toEqual(['persona-app']);

    const finished = await deleteMcpServerAndMoveUses('github-old', plan, null);

    expect(finished).toMatchObject({ status: 'deleted', summary: { flows: [], personas: ['Jim'] } });
    expect((await listPersonaAppGrants(personaId)).map((grant) => grant.mcpServerName)).toEqual(['github-new']);
  }));

  it('finishes a Persona switch that stopped after the new app was granted', () => isolated(async () => {
    const personaId = await personaWithApp('Jim', 'github-old');
    jest.mocked(deletePersonaAppGrantRecord).mockRejectedValueOnce(new Error('disk was busy'));
    const choice = { replaceWith: 'github-new' } as const;

    await expect(releasePersonaApp(personaId, 'github-old', choice)).rejects.toThrow('disk was busy');
    expect((await listPersonaAppGrants(personaId)).map((grant) => grant.mcpServerName).sort()).toEqual(['github-new', 'github-old']);

    await expect(releasePersonaApp(personaId, 'github-old', choice)).resolves.toEqual({ changed: true });
    expect((await listPersonaAppGrants(personaId)).map((grant) => [grant.mcpServerName, grant.enabledTools]))
      .toEqual([['github-new', ['list_issues']]]);
    expect((await getPersona(personaId))!.composition?.appRefs).toEqual(['github-new']);
  }));

  it("names the Persona behind its own copy of an agent and switches that copy like any agent", () => isolated(async () => {
    const bundle = await createPersonaFromRole({ name: 'Ana', idempotencyKey: 'persona-ana' });
    const coreBinding = (await getPersona(bundle.persona.id))!.composition!.coreBinding!;
    const coreId = coreBinding.mode === 'persona_copy' ? coreBinding.personaFlowRef : coreBinding.sharedFlowRef;
    const core = (await flowService.getFlow(coreId))!;
    const withApp = flowUsing(core.id, core.name, 'github-old');
    expect((await flowService.saveFlow({ ...core, nodes: [...core.nodes, withApp.nodes[2]] })).success).toBe(true);

    const usage = (await findMcpServerUsage('github-old'))!;
    expect(usage.uses.map((use) => use.place)).toEqual([
      { kind: 'flow', flowId: core.id, flowName: core.name, steps: 1, personaName: 'Ana' },
    ]);

    const outcome = await deleteMcpServerAndMoveUses('github-old', {
      choices: { [usage.uses[0].key]: { replaceWith: 'github-new' } },
    }, null);

    expect(outcome).toMatchObject({ status: 'deleted', summary: { flows: [core.name] } });
    expect((await appStep(core.id)).properties.boundServer).toBe('github-new');
  }));

  it('asks again when the choices no longer fit the places', () => isolated(async () => {
    await saveFlowUsing('triage', 'Triage', 'github-old');
    await personaWithApp('Jim', 'github-old');

    const outcome = await deleteMcpServerAndMoveUses('github-old', {
      choices: { 'flow:triage': { remove: true } },
    }, null);

    expect(outcome).toMatchObject({ status: 'in-use', changed: true });
    expect((await appStep('triage')).properties.boundServer).toBe('github-old');
  }));

  it('refuses replacements that cannot take over, before changing anything', () => isolated(async () => {
    await saveFlowUsing('triage', 'Triage', 'github-old');
    const personaId = await personaWithApp('Jim', 'github-old');
    const personaKey = `persona:${personaId}:app`;

    for (const [target, reason] of [
      ['github-old', /different app/],
      ['gone', /no longer exists/],
      ['sleepy', /turned off/],
    ] as const) {
      const outcome = await deleteMcpServerAndMoveUses('github-old', {
        choices: { 'flow:triage': { replaceWith: 'github-new' }, [personaKey]: { replaceWith: target } },
      }, null);
      expect(outcome).toMatchObject({ status: 'refused' });
      if (outcome.status === 'refused') expect(outcome.error).toMatch(reason);
    }
    expect((await appStep('triage')).properties.boundServer).toBe('github-old');
  }));

  it('says the app is missing in the Persona Flows area instead of failing, for old data that still names it', () => isolated(async () => {
    const personaId = await personaWithApp('Jim', 'github-old');
    await grantPersonaAppAccess(personaId, { mcpServerName: 'notes' });
    configs.splice(configs.findIndex((config) => config.name === 'github-old'), 1);
    configs.splice(configs.findIndex((config) => config.name === 'notes'), 1, server('notes', true));

    const composition = await readPersonaComposition(personaId);

    expect(composition?.appRefs).toEqual(['github-old', 'notes']);
    expect(composition?.appIssues).toEqual([
      { name: 'github-old', problem: 'missing' },
      { name: 'notes', problem: 'disabled' },
    ]);
  }));
});
