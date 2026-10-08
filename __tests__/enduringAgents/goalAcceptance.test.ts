/** Opt-in product acceptance: real flow engine and MCP; only offline mode replaces the model. */
import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type OpenAI from 'openai';
import { loadConversationStateReadOnly } from '@/backend/execution/flow/loadConversationState';
import { OpenAiAdapter } from '@/backend/services/model/adapters/openaiAdapter';
import { CodexAdapter } from '@/backend/services/model/adapters/codexAdapter';
import type { CompletionInput, CompletionResult } from '@/backend/services/model/adapters/types';
import { createPersonaFromRole } from '@/backend/services/enduringAgents/factory';
import { createPersonaWorkItem } from '@/backend/services/enduringAgents/workItems';
import { initializePersonaRuntimeLockProcessIdentity } from '@/backend/services/enduringAgents/runtimeLock';
import { startPersonaGoalRuntime, stopPersonaGoalRuntime } from '@/backend/services/enduringAgents/goalRuntime';
import { quiescePersonaFlowDispatcher } from '@/backend/services/enduringAgents/personaDispatcher';
import { createRoleVersion, saveRoleDefinition, listPersonaActivities, listPersonaMailboxItems, listPersonaWorkItems, getPersonaWorkItem } from '@/backend/services/enduringAgents/store';
import { mcpService } from '@/backend/services/mcp';
import { saveItem } from '@/utils/storage/backend';
import { runWithWorkspace } from '@/utils/workspace';
import { StorageKey } from '@/shared/types/storage';
import type { Model } from '@/shared/types/model';
import type { PersonaWorkItem } from '@/shared/types/enduringAgent';
import { buildTestRoleDefinition, buildTestRoleVersion } from './fixtures/personaFactory';
import fixture from '../../scripts/persona-goal-acceptance/fixture.cjs';
import terminalFixture from '../../scripts/persona-goal-acceptance/terminal-fixture.cjs';

declare global {
  var __personaGoalAcceptanceNativeCodex: typeof import('@openai/codex-sdk').Codex | undefined;
}

// Module-loader compatibility only: the environment loads the genuine SDK via native ESM.
jest.mock('@openai/codex-sdk', () => {
  if (!globalThis.__personaGoalAcceptanceNativeCodex) throw new Error('Native Codex SDK was not loaded by the goal acceptance environment. Run scripts/run-persona-goal-acceptance.mjs.');
  return { Codex: globalThis.__personaGoalAcceptanceNativeCodex };
}, { virtual: true });

const enabled = ['offline', 'live'].includes(process.env.PERSONA_GOAL_ACCEPTANCE_MODE ?? '');
const timeoutMs = Number(process.env.PERSONA_GOAL_ACCEPTANCE_TIMEOUT_MS ?? 600_000);
jest.setTimeout(timeoutMs + 60_000);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const startupIdentity = { attempts: 0, durationMs: 0 };

function completion(content: string | null, toolCall?: OpenAI.ChatCompletionMessageFunctionToolCall): CompletionResult {
  return { completion: {
    id: `offline-${Date.now()}`, object: 'chat.completion', created: 0, model: 'offline-goal-fixture',
    choices: [{ index: 0, finish_reason: toolCall ? 'tool_calls' : 'stop', logprobs: null,
      message: { role: 'assistant', content, refusal: null, ...(toolCall ? { tool_calls: [toolCall] } : {}) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  } };
}

/** Scripted model only. It reads real fixture observations, calls tools through the actual engine,
 * and deliberately returns partial progress; it never submits a new user task. */
function offlineCompletion(directory: string) {
  let sequence = 0;
  const rounds = new Map<string, { step: number; phase: 'research' | 'launch' | 'publish'; reported?: boolean }>();
  return async (input: CompletionInput): Promise<CompletionResult> => {
    if (input.tools?.some(tool => tool.function.name === 'remember')
      && !input.tools.some(tool => tool.function.name.includes('_research_page_'))) {
      return completion('No additional durable memories are needed.');
    }
    const key = input.conversationId ?? input.runId ?? 'unknown';
    let round = rounds.get(key);
    if (!round) {
      const artifacts = await fixture.readArtifacts(directory);
      round = { step: 0, phase: !artifacts['research.md'] ? 'research' : !artifacts['launch.md'] ? 'launch' : 'publish' };
      rounds.set(key, round);
    }
    const call = (name: string, args: Record<string, unknown> = {}) => {
      const tool = input.tools?.find(candidate => candidate.function.name === name || input.toolNameMap?.[candidate.function.name]?.tool === name || candidate.function.name.includes(`_${name}_`));
      if (!tool) throw new Error(`Real flow did not expose fixture tool ${name}; available=${input.tools?.map(candidate => candidate.function.name).join(',')}`);
      return completion(null, { id: `fixture-call-${++sequence}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(args) } });
    };
    if (round.phase === 'research') {
      const bootstrap = ['research_page', 'terminal', 'terminal', 'research_page'];
      if (round.step < bootstrap.length) {
        const index = round.step++;
        return call(bootstrap[index], index === 1 ? { command: 'cat README.md' } : index === 2 ? { command: 'node install-research-client.cjs' } : {});
      }
    } else if (round.phase === 'launch' && round.step++ === 0) return call('research_page');
    if ((round.phase === 'research' && round.step++ === 4) || (round.phase === 'launch' && round.step === 2)) {
      // The actual tool response must contain this run's random facts.
      const wire = JSON.stringify(input.messages);
      const { facts } = await fixture.readFixture(directory);
      if (!wire.includes(facts.sourceId)) throw new Error('Research tool observation was not delivered to the model.');
      return call('write_artifact', { name: `${round.phase}.md`, content: `# FLUJO ${round.phase}\nSource: ${facts.sourceId}\nAudience: ${facts.audience}\nBenefit: ${facts.benefit}\nUse the developer community channel with useful, evidence-based product examples.` });
    }
    if (round.phase === 'publish' && round.step++ === 0) return call('publish_campaign');
    const verified = await fixture.verifyFixture(directory);
    if (!round.reported) {
      round.reported = true;
      return call('report_activity_outcome', {
        resolution: verified.publicationVerified ? 'succeeded' : 'partial',
        summary: verified.publicationVerified ? 'Both sourced deliverables were published and verified.' : `${round.phase} progress saved; the overall goal has remaining work.`,
        goal_achieved: verified.publicationVerified,
        ...(!verified.publicationVerified ? { next_action: round.phase === 'research' ? 'Create the launch artifact.' : 'Publish the campaign; retry any temporary service outage in the next Activity.' } : {}),
      });
    }
    return completion('The Activity outcome and next step have been recorded.');
  };
}

(enabled ? describe : describe.skip)('one-goal Persona product acceptance', () => {
  beforeAll(async () => {
    const started = Date.now();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      startupIdentity.attempts = attempt;
      try {
        await initializePersonaRuntimeLockProcessIdentity();
        startupIdentity.durationMs = Date.now() - started;
        return;
      } catch (error) {
        if (attempt === 5) throw error;
        await sleep(Math.min(attempt * 500, 2_000));
      }
    }
  }, 65_000);

  it('loads the native SDK without substituting its implementation', async () => {
    if (process.env.PERSONA_GOAL_ACCEPTANCE_MODE !== 'live') return;
    const sdk = await import('@openai/codex-sdk');
    expect(typeof sdk.Codex).toBe('function');
    expect(sdk.Codex).toBe(globalThis.__personaGoalAcceptanceNativeCodex);
  });

  it('continues through durable rounds, a controller restart and a recoverable external outage', async () => {
    const mode = process.env.PERSONA_GOAL_ACCEPTANCE_MODE!;
    const toolsMode = process.env.PERSONA_GOAL_ACCEPTANCE_TOOLS ?? 'structured';
    const terminalOnly = toolsMode === 'terminal-only';
    const acceptanceFixture = terminalOnly ? terminalFixture : fixture;
    const directory = path.resolve(process.env.PERSONA_GOAL_ACCEPTANCE_OUTPUT ?? 'goal-acceptance-artifacts');
    const workspaceId = `goal-acceptance-${process.pid}-${Date.now()}`;
    const startedAt = Date.now();
    const fixtureDir = path.join(directory, 'fixture');
    await acceptanceFixture.createFixture(fixtureDir, 10_000);
    const model: Model = {
      id: 'goal-acceptance-model', name: mode === 'live' ? process.env.PERSONA_GOAL_ACCEPTANCE_MODEL ?? 'gpt-6-astra' : 'offline-goal-fixture',
      displayName: 'Goal acceptance model', adapter: mode === 'live' ? 'codex-cli' : 'openai', provider: 'openai',
      ApiKey: mode === 'live' ? '' : 'offline-fixture', supportsTools: true, maxTurns: terminalOnly ? 25 : 12, reasoningEffort: 'medium',
    };
    const modelCalls: Array<{ model: string; adapter: string | undefined; conversationId?: string; at: number }> = [];
    const scripted = offlineCompletion(fixtureDir);
    const prototype = mode === 'live' ? CodexAdapter.prototype : OpenAiAdapter.prototype;
    const originalCompletion = prototype.createCompletion;
    const invoke = async function(this: CodexAdapter | OpenAiAdapter, input: CompletionInput) {
      modelCalls.push({ model: input.model.name, adapter: input.model.adapter, conversationId: input.conversationId, at: Date.now() });
      return mode === 'live' ? originalCompletion.call(this, input) : scripted(input);
    };
    jest.spyOn(prototype, 'createCompletion').mockImplementation(invoke);
    if (mode === 'offline') jest.spyOn(OpenAiAdapter.prototype, 'createStreamCompletion').mockImplementation(invoke);
    const snapshots: Array<{ at: number; goal?: PersonaWorkItem['goal']; status: string }> = [];
    let report: Record<string, unknown> | undefined;
    let error: unknown;
    await runWithWorkspace(workspaceId, async () => {
      let personaId: string | undefined;
      try {
        await saveItem(StorageKey.MODELS, [model]);
        await saveItem(StorageKey.MCP_SERVERS, { 'goal-acceptance': {
          name: 'goal-acceptance', transport: 'stdio', command: process.execPath,
          args: [path.resolve(`scripts/persona-goal-acceptance/${terminalOnly ? 'terminal-server.mjs' : 'server.mjs'}`), fixtureDir],
          env: {}, disabled: false, rootPath: process.cwd(), source: { type: 'local' },
        } });
        const roleDefinition = buildTestRoleDefinition();
        const roleVersion = buildTestRoleVersion();
        roleDefinition.name = 'Marketing agent';
        roleVersion.mission = 'Research FLUJO, create sourced campaign deliverables and verify their publication. Pursue the ongoing goal until the success criteria are met. Tools are preassigned. Ask no questions for temporary service failures; preserve progress and retry later.';
        const boundedActivity = '\nFor this acceptance campaign, author at most ONE campaign deliverable per Activity, then call report_activity_outcome with resolution partial, a concrete summary and next_action. Setup code and scripts are not campaign deliverables. In a later Activity author the next deliverable, then publish only after both exist. Inspect existing artifacts at the beginning of each Activity. Treat a retryable publication error as partial progress and continue in a later Activity. Call report_activity_outcome with goal_achieved true only after verifying the real published state. Never invent researched facts or publication claims.';
        for (const flow of [roleVersion.coreFlowTemplate, ...roleVersion.behaviorSlots.filter(slot => slot.key === 'primary').map(slot => slot.flowTemplate)]) {
          if (!flow) continue;
          for (const node of flow.nodes ?? []) if (node.type === 'process') {
            node.data.properties = { ...node.data.properties, promptTemplate: `${node.data.properties?.promptTemplate ?? ''}${boundedActivity}` };
          }
        }
        await saveRoleDefinition(roleDefinition);
        await createRoleVersion(roleVersion);
        const bundle = await createPersonaFromRole({ name: 'Frederik acceptance', roleVersionId: roleVersion.id, appRefs: ['goal-acceptance'], mission: 'Make FLUJO known through a sourced, verifiable campaign.' });
        personaId = bundle.persona.id;
        const baselineItems = await listPersonaWorkItems(personaId);
        const goal = await createPersonaWorkItem({ personaId, title: 'Make FLUJO known with a verified campaign', description: terminalOnly
          ? 'Your only external capability is the terminal. Read README.md in its isolated working directory to discover the campaign environment. Install and use a real headless Chromium browser to research the local campaign page, resolving missing dependencies yourself. Write research.md and launch.md using the actual source ID, audience and benefit. Publish through the local endpoint and verify its state. Choose your own tools and commands, keep installations and files inside the workspace, and continue across Activities and transient failures without supervisor input.'
          : 'Research the controlled campaign page. Write research.md and launch.md using its actual source ID, audience and benefit. Publish the campaign using the preassigned tools. Continue across Activities and transient failures until the publication is verified.',
          goal: { successCriteria: `${terminalOnly ? 'A real headless Chromium browser was installed and used to read the campaign research page. ' : ''}Both research.md and launch.md cite the exact research source and facts; the publication service confirms the launch artifact is actually published.`, completionPolicy: 'success_criteria', continuationIntervalMs: 10_000, maxRounds: 10, maxConsecutiveFailures: 3 } });
        await startPersonaGoalRuntime();
        let restarted = false;
        let restartAt: number | undefined;
        let roundsBeforeRestart = 0;
        let current = goal;
        while (Date.now() - startedAt < timeoutMs) {
          current = await getPersonaWorkItem(personaId, goal.id) ?? current;
          const last = snapshots.at(-1);
          if (JSON.stringify(last?.goal) !== JSON.stringify(current.goal) || last?.status !== current.status) {
            snapshots.push({ at: Date.now(), goal: current.goal, status: current.status });
            process.stdout.write(`[goal-acceptance] ${mode}: round=${current.goal?.rounds ?? 0} state=${current.goal?.state ?? current.status}\n`);
          }
          if (!restarted && (current.goal?.rounds ?? 0) >= 1 && !current.goal?.pendingTaskId) {
            roundsBeforeRestart = current.goal?.rounds ?? 0;
            stopPersonaGoalRuntime();
            await sleep(250);
            restartAt = Date.now();
            await startPersonaGoalRuntime();
            restarted = true;
          }
          if (['completed', 'needs_input', 'stopped', 'paused'].includes(current.goal?.state ?? '')) break;
          await sleep(250);
        }
        const external = await acceptanceFixture.verifyFixture(fixtureDir);
        const [items, activities, mailbox] = await Promise.all([listPersonaWorkItems(personaId), listPersonaActivities(personaId), listPersonaMailboxItems(personaId)]);
        const goals = items.filter(item => item.goal);
        const goalTasks = items.filter(item => item.parentGoalId === goal.id);
        const taskIds = new Set([goal.id, ...goalTasks.map(item => item.id)]);
        const admitted = mailbox.filter(item => item.source.kind === 'assignment' && taskIds.has(item.source.sourceId ?? ''));
        const interventions = snapshots.filter(snapshot => snapshot.goal?.state === 'needs_input' || snapshot.goal?.interventionReason);
        const humanInputs = mailbox.filter(item => item.source.kind === 'chat');
        const conversations = await Promise.all(activities.filter(activity => activity.conversationId).map(async activity => {
          const state = await loadConversationStateReadOnly(activity.conversationId!);
          return { activityId: activity.id, conversationId: activity.conversationId, messages: state?.messages ?? [] };
        }));
        const checks = {
          oneInitialGoal: baselineItems.length === 0 && goals.length === 1 && goals[0].id === goal.id,
          autonomousContinuation: new Set(admitted.map(item => item.idempotencyKey)).size >= 3
            && activities.filter(activity => activity.source.kind === 'assignment' && taskIds.has(activity.source.sourceId ?? '')).length >= 3,
          verifiedDeliverables: external.artifacts.length === 2 && external.artifacts.every(artifact => artifact.verified) && external.publicationVerified,
          noHumanIntervention: interventions.length === 0 && humanInputs.length === 0,
          noPrematureStop: current.goal?.state === 'completed' && external.publicationVerified,
          controllerRestartRecovery: restarted && (current.goal?.rounds ?? 0) > roundsBeforeRestart && activities.some(activity => activity.createdAt >= (restartAt ?? Infinity)),
          transientFailureRecovery: external.transientFailureObserved && external.publishAttempts >= 2 && external.publicationVerified,
          environmentBootstrapRecovery: external.environmentBootstrapVerified,
          actualModelObserved: modelCalls.length > 0 && modelCalls.every(call => call.model === model.name && call.adapter === model.adapter),
          ...(terminalOnly ? { browserExecution: 'browserExecutionVerified' in external && external.browserExecutionVerified === true } : {}),
        };
        report = {
          schemaVersion: 1, runId: process.env.PERSONA_GOAL_ACCEPTANCE_RUN_ID, mode,
          startupIdentity,
          authoritativeLiveModel: mode === 'live', commitSha: process.env.PERSONA_GOAL_ACCEPTANCE_COMMIT,
          sourceDiffSha256: process.env.PERSONA_GOAL_ACCEPTANCE_DIFF_SHA256,
          startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(),
          configuration: { model: { ...model, ApiKey: undefined }, toolsMode, timeoutMs, continuationIntervalMs: 10_000, workspaceId, goalId: goal.id, personaId, fixtureVersion: terminalOnly ? 2 : 1, roleVersionId: roleVersion.id, roleMission: roleVersion.mission, initialGoal: goal.description, successCriteria: goal.goal?.successCriteria },
          boundaries: { flowExecution: 'production runFlow', externalTools: terminalOnly ? 'one general terminal via production MCP; real local shell, network dependency/browser installation, localhost research/publication service' : 'production MCP transport to controlled local service', model: mode === 'live' ? 'production Codex adapter and genuine SDK, loaded outside Jest VM through native ESM' : 'scripted completion adapter', restart: 'goal controller stop/start; not an OS process crash', ui: 'not exercised', authoredActivityLimit: 'one campaign deliverable per Activity forces a controlled continuation scenario; this is not proof of emergent marketing strategy', environmentBootstrap: terminalOnly ? 'model-driven real headless Chromium install/use; native child launch observation plus browser-rendered HTTP research receipt' : 'actual local Node client installation using a bounded terminal, not an OS browser installation' },
          checks, snapshots, modelCalls, goals, goalTasks, activities, mailbox, conversations, external,
          observations: { initialGoals: goals.length, admittedAutonomousRounds: admitted.length, completedRounds: current.goal?.rounds ?? 0, humanInterventions: humanInputs.length, humanInterventionRequests: interventions.length, prematureStops: current.goal?.state !== 'active' && !external.publicationVerified ? 1 : 0, timedOut: current.goal?.state === 'active' && Date.now() - startedAt >= timeoutMs, restartAt, roundsBeforeRestart },
        };
        expect(checks).toEqual(Object.fromEntries(Object.keys(checks).map(key => [key, true])));
      } catch (caught) { error = caught; }
      finally {
        stopPersonaGoalRuntime();
        if (personaId) await quiescePersonaFlowDispatcher(personaId);
        await mcpService.disconnectAll('goal acceptance finished');
      }
    });
    await fs.mkdir(directory, { recursive: true });
    const serialized = JSON.stringify(report ?? { schemaVersion: 1, runId: process.env.PERSONA_GOAL_ACCEPTANCE_RUN_ID, mode, commitSha: process.env.PERSONA_GOAL_ACCEPTANCE_COMMIT, sourceDiffSha256: process.env.PERSONA_GOAL_ACCEPTANCE_DIFF_SHA256, configuration: { model: { ...model, ApiKey: undefined }, toolsMode, fixtureVersion: terminalOnly ? 2 : 1, timeoutMs, workspaceId }, modelCalls, snapshots, checks: {}, failure: String(error), startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString() }, null, 2);
    await fs.writeFile(path.join(directory, 'persona-goal-acceptance.json'), `${serialized}\n`);
    await fs.writeFile(path.join(directory, 'SHA256SUMS'), `${createHash('sha256').update(`${serialized}\n`).digest('hex')}  persona-goal-acceptance.json\n`);
    if (error) throw error;
  });
});
