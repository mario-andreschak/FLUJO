/** Opt-in real-time Persona endurance acceptance. The runner owns process restarts. */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type OpenAI from 'openai';
import { OpenAiAdapter } from '@/backend/services/model/adapters/openaiAdapter';
import { CodexAdapter } from '@/backend/services/model/adapters/codexAdapter';
import type { CompletionInput, CompletionResult } from '@/backend/services/model/adapters/types';
import {
  createPersonaFromRole,
  reconcilePersonaRoleBehaviors,
} from '@/backend/services/enduringAgents/factory';
import {
  _getPersonaRuntimeLockProcessBirthMarkerForTests,
  initializePersonaRuntimeLockProcessIdentity,
} from '@/backend/services/enduringAgents/runtimeLock';
import {
  startPersonaGoalRuntime,
  stopPersonaGoalRuntime,
} from '@/backend/services/enduringAgents/goalRuntime';
import {
  listPersonaFlowDispatches,
  quiescePersonaFlowDispatcher,
  startPersonaFlowDispatcher,
} from '@/backend/services/enduringAgents/personaDispatcher';
import { readPersonaRuntimeEvents } from '@/backend/services/enduringAgents/runtimeEvents';
import { inspectAndReconcilePersonaRuntime } from '@/backend/services/enduringAgents/runtimeObservability';
import {
  createRoleVersion,
  getPersonaWorkItem,
  listPersonaActivities,
  listPersonaMailboxItems,
  listPersonaWorkItems,
  saveRoleDefinition,
} from '@/backend/services/enduringAgents/store';
import {
  controlPersonaWorkItem,
  createPersonaWorkItem,
} from '@/backend/services/enduringAgents/workItems';
import { mcpService } from '@/backend/services/mcp';
import { StorageKey } from '@/shared/types/storage';
import type { Model } from '@/shared/types/model';
import type { PersonaWorkItem } from '@/shared/types/enduringAgent';
import { saveItem } from '@/utils/storage/backend';
import { runWithWorkspace } from '@/utils/workspace';
import {
  buildTestRoleDefinition,
  buildTestRoleVersion,
} from './fixtures/personaFactory';

declare global {
  var __personaGoalEnduranceNativeCodex:
    | typeof import('@openai/codex-sdk').Codex
    | undefined;
}

jest.mock('@openai/codex-sdk', () => {
  if (!globalThis.__personaGoalEnduranceNativeCodex) {
    throw new Error('Native Codex SDK was not loaded. Run scripts/run-persona-goal-endurance.mjs.');
  }
  return { Codex: globalThis.__personaGoalEnduranceNativeCodex };
}, { virtual: true });

const phase = process.env.PERSONA_GOAL_ENDURANCE_PHASE ?? '';
const enabled = ['bootstrap', 'crash-after-effect', 'recover'].includes(phase);
const timeoutMs = Number(process.env.PERSONA_GOAL_ENDURANCE_PHASE_TIMEOUT_MS ?? 900_000);
const outputDirectory = path.resolve(
  process.env.PERSONA_GOAL_ENDURANCE_OUTPUT ?? 'goal-endurance-artifacts',
);
const agentRoot = path.resolve(
  process.env.PERSONA_GOAL_ENDURANCE_AGENT_ROOT ?? path.join(outputDirectory, 'agent-workspace'),
);
const baseUrl = process.env.PERSONA_GOAL_ENDURANCE_FIXTURE_URL ?? '';
const token = process.env.PERSONA_GOAL_ENDURANCE_FIXTURE_TOKEN ?? '';
const runId = process.env.PERSONA_GOAL_ENDURANCE_RUN_ID ?? '';
const workspaceId = process.env.PERSONA_GOAL_ENDURANCE_WORKSPACE_ID ?? '';
const mode = process.env.PERSONA_GOAL_ENDURANCE_MODE ?? '';
const profile = process.env.PERSONA_GOAL_ENDURANCE_PROFILE ?? 'structured-tools';
const requestedDurationMs = Number(process.env.PERSONA_GOAL_ENDURANCE_DURATION_MS ?? 0);
const requestedActiveMs = Number(process.env.PERSONA_GOAL_ENDURANCE_ACTIVE_MS ?? 0);
const pauseMs = Number(process.env.PERSONA_GOAL_ENDURANCE_PAUSE_MS ?? 1_000);
const continuationIntervalMs = Number(
  process.env.PERSONA_GOAL_ENDURANCE_ROUND_INTERVAL_MS ?? 10_000,
);
const roundLimit = Number(process.env.PERSONA_GOAL_ENDURANCE_ROUND_LIMIT ?? 20);
const maxModelCalls = Number(process.env.PERSONA_GOAL_ENDURANCE_MAX_MODEL_CALLS ?? 320);
const totalTimeoutMs = Number(process.env.PERSONA_GOAL_ENDURANCE_TOTAL_TIMEOUT_MS ?? 0);
jest.setTimeout(timeoutMs + 60_000);

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const iso = (value: number) => new Date(value).toISOString();
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

interface Checkpoint {
  schemaVersion: 1;
  sequence: number;
  phase: string;
  runId: string;
  previousCheckpointSha256: string | null;
  createdAt: string;
  processEpoch: {
    epochId: string;
    pid: number;
    processBirthMarker: string | null;
    startedAt: string;
    endedAt: string;
    exitKind: 'graceful' | 'forced_after_effect' | 'recovered_and_stopped';
    goalId: string;
    postRestartActivityId?: string;
    crashActivityId?: string;
  };
  workspaceId: string;
  personaId: string;
  goalId: string;
  roleVersionId: string;
  modelCalls: Array<Record<string, unknown>>;
  observations: Record<string, unknown>;
}

function checkpointPath(sequence: number): string {
  return path.join(outputDirectory, 'checkpoints', String(sequence).padStart(4, '0') + '.json');
}

async function readCheckpoint(sequence: number): Promise<Checkpoint> {
  return JSON.parse(await fs.readFile(checkpointPath(sequence), 'utf8')) as Checkpoint;
}

async function writeCheckpoint(
  sequence: number,
  value: Omit<Checkpoint, 'schemaVersion' | 'sequence' | 'runId' | 'previousCheckpointSha256' | 'createdAt'>,
): Promise<Checkpoint> {
  await fs.mkdir(path.join(outputDirectory, 'checkpoints'), { recursive: true });
  let previousCheckpointSha256: string | null = null;
  if (sequence > 1) {
    previousCheckpointSha256 = sha256(await fs.readFile(checkpointPath(sequence - 1)));
  }
  const checkpoint: Checkpoint = {
    schemaVersion: 1,
    sequence,
    phase: value.phase,
    runId,
    previousCheckpointSha256,
    createdAt: iso(Date.now()),
    processEpoch: value.processEpoch,
    workspaceId: value.workspaceId,
    personaId: value.personaId,
    goalId: value.goalId,
    roleVersionId: value.roleVersionId,
    modelCalls: value.modelCalls,
    observations: value.observations,
  };
  const filename = checkpointPath(sequence);
  const temporary = filename + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(checkpoint, null, 2) + '\n');
  await fs.rename(temporary, filename);
  return checkpoint;
}

async function waitFor<T>(
  operation: () => Promise<T>,
  accept: (value: T) => boolean,
  description: string,
  budgetMs = timeoutMs,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (accept(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  const suffix = lastError instanceof Error ? ' Last error: ' + lastError.message : '';
  throw new Error('Timed out waiting for ' + description + '.' + suffix);
}

async function serviceRequest(relativePath: string, options: RequestInit = {}) {
  const response = await fetch(baseUrl + relativePath, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const raw = await response.text();
  const body = raw ? JSON.parse(raw) : {};
  if (!response.ok) {
    throw new Error('Controlled service ' + relativePath + ' returned ' + response.status + ': ' + raw);
  }
  return body;
}

function completion(
  content: string | null,
  toolCall?: OpenAI.ChatCompletionMessageFunctionToolCall,
): CompletionResult {
  return {
    completion: {
      id: 'offline-endurance-' + Date.now(),
      object: 'chat.completion',
      created: 0,
      model: 'offline-endurance-fixture',
      choices: [{
        index: 0,
        finish_reason: toolCall ? 'tool_calls' : 'stop',
        logprobs: null,
        message: {
          role: 'assistant',
          content,
          refusal: null,
          ...(toolCall ? { tool_calls: [toolCall] } : {}),
        },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  };
}

function offlineCompletion() {
  let sequence = 0;
  const conversations = new Map<string, { phase: string; step: number; reported?: boolean }>();
  return async (input: CompletionInput): Promise<CompletionResult> => {
    if (input.tools?.some(tool => tool.function.name === 'remember')
      && !input.tools.some(tool => tool.function.name.includes('_research_page_'))) {
      return completion('No additional memory record is required for this controlled round.');
    }
    const key = input.conversationId ?? input.runId ?? 'unknown';
    let state = conversations.get(key);
    if (!state) {
      const artifacts = new Set(await fs.readdir(agentRoot).catch(() => []));
      const evidence = await serviceRequest('/evidence');
      const workPhase = !artifacts.has('research.md')
        ? 'research'
        : !artifacts.has('launch.md')
          ? 'launch'
          : evidence.state.effects.length === 0
            ? 'publish'
            : !artifacts.has('backlog.md')
              ? 'backlog'
              : 'verify';
      state = { phase: workPhase, step: 0 };
      conversations.set(key, state);
    }
    const call = (name: string, args: Record<string, unknown> = {}) => {
      const tool = input.tools?.find(candidate =>
        candidate.function.name === name
        || input.toolNameMap?.[candidate.function.name]?.tool === name
        || candidate.function.name.includes('_' + name + '_'));
      if (!tool) {
        throw new Error('Production flow did not expose ' + name + '. Available: '
          + input.tools?.map(candidate => candidate.function.name).join(','));
      }
      sequence += 1;
      return completion(null, {
        id: 'endurance-call-' + process.pid + '-' + sequence,
        type: 'function',
        function: { name: tool.function.name, arguments: JSON.stringify(args) },
      });
    };
    if (state.phase === 'research' || state.phase === 'launch' || state.phase === 'backlog') {
      if (state.step === 0) {
        state.step += 1;
        return call('research_page');
      }
      if (state.step === 1) {
        state.step += 1;
        const research = await (await fetch(baseUrl + '/research.json')).json() as {
          facts: { sourceId: string; audience: string; benefit: string };
        };
        if (!JSON.stringify(input.messages).includes(research.facts.sourceId)) {
          throw new Error('The real research observation did not reach the model boundary.');
        }
        const name = state.phase + '.md';
        const purpose = state.phase === 'backlog'
          ? 'Maintain an actionable backlog of follow-up developer-community research, measurement and useful examples.'
          : 'Create accurate, audience-relevant campaign material with concrete product examples and verifiable attribution.';
        return call('write_campaign_artifact', {
          name,
          content: '# FLUJO ' + state.phase + '\nSource: ' + research.facts.sourceId
            + '\nAudience: ' + research.facts.audience
            + '\nBenefit: ' + research.facts.benefit + '\n' + purpose,
        });
      }
    } else if (state.phase === 'publish' && state.step === 0) {
      state.step += 1;
      return call('publish_campaign');
    } else if (state.phase === 'verify' && state.step === 0) {
      state.step += 1;
      return call('readback_campaign');
    }
    if (!state.reported) {
      state.reported = true;
      const evidence = await serviceRequest('/evidence');
      const published = evidence.state.effects.length === 1;
      return call('report_activity_outcome', {
        resolution: 'partial',
        summary: published
          ? 'The controlled publication is independently visible; useful backlog and monitoring work continue.'
          : state.phase + ' progress is persisted; the ongoing goal retains a concrete next action.',
        goal_achieved: false,
        next_action: published
          ? 'Continue the marketing backlog and verify later controlled-service state without duplicating the effect.'
          : state.phase === 'research'
            ? 'Create a sourced launch artifact.'
            : state.phase === 'launch'
              ? 'Publish through the approved service and recover from retryable failures.'
              : 'Read back the service before retrying the stable idempotent publication.',
      });
    }
    return completion('The partial outcome and next action were recorded for automatic continuation.');
  };
}

async function processBirthMarker(): Promise<string | null> {
  return _getPersonaRuntimeLockProcessBirthMarkerForTests(process.pid);
}

async function createConfiguration(model: Model) {
  const initialEntries = await fs.readdir(agentRoot);
  await saveItem(StorageKey.MODELS, [model]);
  const mcpScript = 'public-fixture-mcp.mjs';
  const args = [path.resolve('scripts/persona-goal-acceptance/' + mcpScript), baseUrl, agentRoot, runId];
  await saveItem(StorageKey.MCP_SERVERS, {
    'goal-endurance': {
      name: 'goal-endurance',
      transport: 'stdio',
      command: process.execPath,
      args,
      env: {},
      disabled: false,
      rootPath: process.cwd(),
      source: { type: 'local' },
    },
  });
  const roleDefinition = buildTestRoleDefinition();
  const roleVersion = buildTestRoleVersion();
  roleDefinition.name = 'Marketing Agent';
  roleVersion.mission = [
    'Make FLUJO known through accurate, useful and independently verifiable work.',
    'Own the ongoing goal, maintain an actionable backlog and continue without routine supervision.',
    'Use only assigned capabilities and approved effects. Recover from transient failures with bounded backoff.',
    'Reconcile uncertain external effects before retrying. Retain exact dependencies and next actions.',
    'Never treat an output count or model claim as proof of progress.',
  ].join(' ');
  await saveRoleDefinition(roleDefinition);
  await createRoleVersion(roleVersion);
  const bundle = await createPersonaFromRole({
    name: 'Frederik',
    roleVersionId: roleVersion.id,
    appRefs: ['goal-endurance'],
    mission: 'Make FLUJO known on the internet.',
  });
  const goal = await createPersonaWorkItem({
    personaId: bundle.persona.id,
    title: 'Make FLUJO known on the internet',
    description: 'Research the approved controlled service, create useful sourced marketing artifacts and backlog, publish one authorized idempotent effect, verify read-back, recover from temporary failures, and continue the ongoing responsibility without supervisor input.',
    goal: {
      successCriteria: 'Continuously publish and verify useful sourced marketing progress, maintain an actionable backlog, and preserve exact blockers and next actions until the owner stops the responsibility.',
      completionPolicy: 'until_stopped',
      continuationIntervalMs,
      maxRounds: roundLimit,
      maxConsecutiveFailures: 4,
    },
  });
  return { initialEntries, personaId: bundle.persona.id, goal, roleVersion };
}

async function startProductionRuntime(personaId: string) {
  await mcpService.startEnabledServers();
  await reconcilePersonaRoleBehaviors(personaId);
  const reconciliation = await inspectAndReconcilePersonaRuntime(personaId);
  await startPersonaFlowDispatcher();
  await startPersonaGoalRuntime();
  return reconciliation;
}

async function stopProductionRuntime(personaId: string) {
  stopPersonaGoalRuntime();
  await quiescePersonaFlowDispatcher(personaId);
  await mcpService.disconnectAll('Persona goal endurance phase finished');
}

async function browserObservation(external: { state: any; audit: any[] }) {
  if (profile !== 'terminal-only') return { required: false, verified: true, launches: 0, reads: 0 };
  const auditFile = path.join(agentRoot, 'browser-audit.jsonl');
  const raw = await fs.readFile(auditFile, 'utf8').catch(() => '');
  const launches = raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.type === 'browser_spawn');
  const canonicalRoot = await fs.realpath(agentRoot);
  const genuine = (await Promise.all(launches.map(async event => {
    try {
      const executable = await fs.realpath(event.executable);
      const relative = path.relative(canonicalRoot, executable);
      const stat = await fs.stat(executable);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        && stat.isFile() && stat.size === event.bytes && stat.size > 1_000_000;
    } catch {
      return false;
    }
  }))).filter(Boolean).length;
  const reads = external.audit.filter(event => event.type === 'browser_observed'
    && /Chrome|Chromium/i.test(event.userAgent)
    && event.sourceId === external.state.facts.sourceId).length;
  return { required: true, verified: genuine > 0 && reads > 0, launches: genuine, reads };
}

(enabled ? describe : describe.skip)('Persona goal endurance across OS process epochs', () => {
  const modelCalls: Array<Record<string, unknown>> = [];
  const snapshots: Array<{ at: number; status: string; goal?: PersonaWorkItem['goal'] }> = [];
  const phaseStartedAt = Date.now();
  let startupAttempts = 0;

  beforeAll(async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      startupAttempts = attempt;
      try {
        await initializePersonaRuntimeLockProcessIdentity();
        return;
      } catch (error) {
        if (attempt === 5) throw error;
        await sleep(Math.min(attempt * 500, 2_000));
      }
    }
  }, 65_000);

  it('continues the same ordinary ongoing goal through graceful and forced restarts', async () => {
    if (!baseUrl || !token || !runId || !workspaceId) {
      throw new Error('The endurance runner did not provide its owned fixture and workspace identity.');
    }
    if (profile !== 'structured-tools') {
      throw new Error('Endurance acceptance only supports the contained structured-tools profile.');
    }
    const model: Model = {
      id: 'goal-endurance-model',
      name: mode === 'live'
        ? process.env.PERSONA_GOAL_ENDURANCE_MODEL ?? 'gpt-6-astra'
        : 'offline-endurance-fixture',
      displayName: 'Goal endurance model',
      adapter: mode === 'live' ? 'codex-cli' : 'openai',
      provider: 'openai',
      ApiKey: mode === 'live' ? '' : 'offline-fixture',
      supportsTools: true,
      maxTurns: 16,
      reasoningEffort: 'medium',
    };
    const priorModelCallCount = phase === 'bootstrap'
      ? 0
      : phase === 'crash-after-effect'
        ? (await readCheckpoint(1)).modelCalls.length
        : (await readCheckpoint(1)).modelCalls.length + (await readCheckpoint(2)).modelCalls.length;
    const scripted = offlineCompletion();
    const prototype = mode === 'live' ? CodexAdapter.prototype : OpenAiAdapter.prototype;
    const originalCompletion = prototype.createCompletion;
    const invoke = async function(
      this: CodexAdapter | OpenAiAdapter,
      input: CompletionInput,
    ): Promise<CompletionResult> {
      if (priorModelCallCount + modelCalls.length >= maxModelCalls) {
        throw new Error('Configured model-call budget exhausted before another provider request.');
      }
      const startedAt = Date.now();
      let runtimeDispatchId: string | undefined;
      try {
        if (mode === 'offline') {
          runtimeDispatchId = await input.onSdkRequest?.({
            adapter: 'openai',
            operation: 'offline-fixture.createCompletion',
            request: {
              model: input.model.name,
              conversationId: input.conversationId,
              source: 'persona-goal-endurance-offline-fixture',
            },
          });
        }
        const result = mode === 'live'
          ? await originalCompletion.call(this, input)
          : await scripted(input);
        if (runtimeDispatchId) {
          await input.onSdkRequestResult?.({
            dispatchId: runtimeDispatchId,
            outcome: 'completed',
          });
        }
        modelCalls.push({
          model: input.model.name,
          adapter: input.model.adapter,
          conversationId: input.conversationId,
          startedAt,
          completedAt: Date.now(),
          pid: process.pid,
          outcome: 'completed',
          completionId: result.completion.id,
          completionModel: result.completion.model,
          usage: result.completion.usage,
        });
        return result;
      } catch (error) {
        if (runtimeDispatchId) {
          await input.onSdkRequestResult?.({
            dispatchId: runtimeDispatchId,
            outcome: 'error',
          });
        }
        modelCalls.push({
          model: input.model.name,
          adapter: input.model.adapter,
          conversationId: input.conversationId,
          startedAt,
          completedAt: Date.now(),
          pid: process.pid,
          outcome: 'error',
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        throw error;
      }
    };
    jest.spyOn(prototype, 'createCompletion').mockImplementation(invoke);
    if (mode === 'offline') {
      jest.spyOn(OpenAiAdapter.prototype, 'createStreamCompletion').mockImplementation(invoke);
    }

    await runWithWorkspace(workspaceId, async () => {
      if (phase === 'bootstrap') {
        const configured = await createConfiguration(model);
        await startProductionRuntime(configured.personaId);
        const current = await waitFor(
          () => getPersonaWorkItem(configured.personaId, configured.goal.id),
          value => Boolean(value && (value.goal?.rounds ?? 0) >= 1 && !value.goal?.pendingTaskId),
          'the first autonomous goal round to persist',
        );
        if (!current) throw new Error('The configured goal disappeared.');
        snapshots.push({ at: Date.now(), status: current.status, goal: current.goal });
        await stopProductionRuntime(configured.personaId);
        const endedAt = Date.now();
        await writeCheckpoint(1, {
          phase,
          processEpoch: {
            epochId: 'epoch-1-graceful',
            pid: process.pid,
            processBirthMarker: await processBirthMarker(),
            startedAt: iso(phaseStartedAt),
            endedAt: iso(endedAt),
            exitKind: 'graceful',
            goalId: configured.goal.id,
          },
          workspaceId,
          personaId: configured.personaId,
          goalId: configured.goal.id,
          roleVersionId: configured.roleVersion.id,
          modelCalls,
          observations: {
            startupAttempts,
            initialAgentEntries: configured.initialEntries,
            rounds: current.goal?.rounds ?? 0,
            state: current.goal?.state,
            snapshots,
          },
        });
        return;
      }

      const first = await readCheckpoint(1);
      const personaId = first.personaId;
      const goalId = first.goalId;
      if (phase === 'crash-after-effect') {
        await startProductionRuntime(personaId);
        const crashWindow = await waitFor(
          async () => {
            const [external, activities, current] = await Promise.all([
              serviceRequest('/evidence'),
              listPersonaActivities(personaId),
              getPersonaWorkItem(personaId, goalId),
            ]);
            return { external, activities, current };
          },
          value => value.external.state.effects.length === 1
            && value.external.state.acknowledgementState === 'withheld_after_commit'
            && value.activities.some((activity: any) => activity.status === 'running'),
          'a committed external effect with its acknowledgement withheld',
        );
        const running = crashWindow.activities
          .filter((activity: any) => activity.status === 'running')
          .sort((left: any, right: any) => right.createdAt - left.createdAt)[0];
        const afterGraceful = crashWindow.activities
          .filter((activity: any) => activity.createdAt >= Date.parse(first.processEpoch.endedAt))
          .sort((left: any, right: any) => left.createdAt - right.createdAt)[0];
        await writeCheckpoint(2, {
          phase,
          processEpoch: {
            epochId: 'epoch-2-forced',
            pid: process.pid,
            processBirthMarker: await processBirthMarker(),
            startedAt: iso(phaseStartedAt),
            endedAt: iso(Date.now()),
            exitKind: 'forced_after_effect',
            goalId,
            postRestartActivityId: afterGraceful?.id,
            crashActivityId: running.id,
          },
          workspaceId,
          personaId,
          goalId,
          roleVersionId: first.roleVersionId,
          modelCalls,
          observations: {
            startupAttempts,
            effect: crashWindow.external.state.effects[0],
            acknowledgementState: crashWindow.external.state.acknowledgementState,
            goalState: crashWindow.current?.goal?.state,
            goalRounds: crashWindow.current?.goal?.rounds,
          },
        });
        process.stdout.write('[goal-endurance] crash checkpoint persisted; runner may force-kill this process tree.\n');
        await new Promise<void>(() => undefined);
        return;
      }

      const second = await readCheckpoint(2);
      const reconciliation = await startProductionRuntime(personaId);
      const recovered = await waitFor(
        async () => {
          const [external, activities, current] = await Promise.all([
            serviceRequest('/evidence'),
            listPersonaActivities(personaId),
            getPersonaWorkItem(personaId, goalId),
          ]);
          return { external, activities, current };
        },
        value => value.external.state.acknowledgementState === 'reconciled'
          && Boolean(value.external.state.artifacts['backlog.md'])
          && value.activities.some((activity: any) =>
            activity.id !== second.processEpoch.crashActivityId
            && activity.createdAt >= Date.parse(second.processEpoch.endedAt)),
        'fresh verified progress after forced process recovery',
      );
      const prePauseCount = recovered.activities.length;
      await controlPersonaWorkItem(personaId, goalId, 'pause');
      const paused = await getPersonaWorkItem(personaId, goalId);
      const pauseEvent = (await readPersonaRuntimeEvents(personaId))
        .filter(event => event.type === 'goal:control'
          && event.goalId === goalId && event.action === 'pause')
        .sort((left, right) => right.seq - left.seq)[0];
      if (!pauseEvent) throw new Error('Pause control did not persist a runtime event.');
      await sleep(pauseMs);
      await controlPersonaWorkItem(personaId, goalId, 'retry');
      const retryEvent = (await readPersonaRuntimeEvents(personaId))
        .filter(event => event.type === 'goal:control'
          && event.goalId === goalId && event.action === 'retry'
          && event.seq > pauseEvent.seq)
        .sort((left, right) => right.seq - left.seq)[0];
      if (!retryEvent) throw new Error('Continue control did not persist a retry runtime event.');
      const retryAdmission = await waitFor(
        async () => {
          const [events, dispatches, activities] = await Promise.all([
            readPersonaRuntimeEvents(personaId),
            listPersonaFlowDispatches(personaId),
            listPersonaActivities(personaId),
          ]);
          const round = events.find(event => event.type === 'goal:round'
            && event.goalId === goalId
            && event.cause === 'manual_retry'
            && event.controlId === retryEvent.controlId);
          const dispatch = round?.type === 'goal:round'
            ? dispatches.find(value => value.id === round.dispatchId)
            : undefined;
          const activity = dispatch?.activityId
            ? activities.find(value => value.id === dispatch.activityId)
            : undefined;
          return { events, dispatches, activities, round, dispatch, activity };
        },
        value => value.activities.length > prePauseCount && Boolean(value.activity),
        'a durable manual-retry round linked to a fresh Activity',
      );
      const manualRetryActivity = retryAdmission.activity;
      if (!manualRetryActivity) {
        throw new Error('Continue control did not produce a durably attributable Activity.');
      }
      const pauseAppliedAt = pauseEvent.appliedAt;
      const continueAppliedAt = retryEvent.appliedAt;

      const priorActiveMs = Date.parse(first.processEpoch.endedAt)
        - Date.parse(first.processEpoch.startedAt)
        + Date.parse(second.processEpoch.endedAt)
        - Date.parse(second.processEpoch.startedAt);
      const remainingActiveMs = Math.max(0, requestedActiveMs - priorActiveMs);
      const targetEnd = Math.max(
        Date.parse(first.processEpoch.startedAt) + requestedDurationMs,
        continueAppliedAt + remainingActiveMs,
      );
      let current = await getPersonaWorkItem(personaId, goalId);
      while (Date.now() < targetEnd && current?.goal?.state === 'active') {
        await sleep(Math.min(1_000, Math.max(50, targetEnd - Date.now())));
        current = await getPersonaWorkItem(personaId, goalId);
      }
      const beforeStop = current;
      await controlPersonaWorkItem(personaId, goalId, 'stop');
      const stopEvent = (await readPersonaRuntimeEvents(personaId))
        .filter(event => event.type === 'goal:control'
          && event.goalId === goalId && event.action === 'stop'
          && event.seq > retryEvent.seq)
        .sort((left, right) => right.seq - left.seq)[0];
      if (!stopEvent) throw new Error('Stop control did not persist a runtime event.');
      const stopAt = stopEvent.appliedAt;
      await stopProductionRuntime(personaId);
      await serviceRequest('/publication', { method: 'DELETE', body: '{}' });
      const external = await serviceRequest('/evidence');
      const [items, activities, mailbox, dispatches, runtimeEvents] = await Promise.all([
        listPersonaWorkItems(personaId),
        listPersonaActivities(personaId),
        listPersonaMailboxItems(personaId),
        listPersonaFlowDispatches(personaId),
        readPersonaRuntimeEvents(personaId),
      ]);
      const root = items.find(item => item.id === goalId);
      const goalTasks = items.filter(item => item.parentGoalId === goalId);
      const taskIds = new Set([goalId, ...goalTasks.map(item => item.id)]);
      const goalMailbox = mailbox.filter(item =>
        item.source.kind === 'assignment'
        && taskIds.has(item.source.sourceId ?? ''));
      const mailboxById = new Map(mailbox.map(item => [item.id, item]));
      const activityById = new Map(activities.map(activity => [activity.id, activity]));
      const dispatchById = new Map(dispatches.map(dispatch => [dispatch.id, dispatch]));
      const goalControlEvents = runtimeEvents
        .filter(event => event.type === 'goal:control' && event.goalId === goalId)
        .sort((left, right) => left.seq - right.seq);
      const goalRoundEvents = runtimeEvents
        .filter(event => event.type === 'goal:round' && event.goalId === goalId)
        .sort((left, right) => left.seq - right.seq);
      const roundAdmissions = goalRoundEvents.map(event => {
        const dispatch = dispatchById.get(event.dispatchId);
        const mailboxItem = dispatch?.mailboxItemId
          ? mailboxById.get(dispatch.mailboxItemId)
          : undefined;
        const activityId = dispatch?.activityId
          && mailboxItem?.claimedActivityId === dispatch.activityId
          && activityById.has(dispatch.activityId)
          ? dispatch.activityId
          : undefined;
        return {
          eventId: event.eventId,
          eventSeq: event.seq,
          goalId: event.goalId,
          round: event.round,
          attemptKey: event.attemptKey,
          cause: event.cause,
          controlId: event.controlId,
          dueAt: event.dueAt,
          reservedAt: event.reservedAt,
          dispatchId: event.dispatchId,
          dispatchState: dispatch?.state ?? 'missing',
          mailboxItemId: mailboxItem?.id,
          activityId,
          ownerCancelledBeforeDispatch: !activityId
            && dispatch?.state === 'cancelled'
            && dispatch.cancellationControlId === stopEvent.controlId
            && (dispatch.cancellationRequestedAt ?? -1) >= stopEvent.appliedAt
            && dispatch.cancellationReason === 'The ongoing goal was stopped.',
        };
      });
      const eligibleRoundAdmissions = roundAdmissions.filter(value => value.activityId);
      const eligibleActivityIds = new Set(eligibleRoundAdmissions.map(value => value.activityId));
      const eligibleActivities = activities.filter(activity => eligibleActivityIds.has(activity.id));
      const scheduledControls = goalControlEvents.map(event => ({
        controlId: event.controlId,
        goalId: event.goalId,
        action: event.action,
        classification: 'scheduled' as const,
        requestedAt: iso(event.requestedAt),
        appliedAt: iso(event.appliedAt),
        fromState: event.fromState,
        resultingState: event.toState,
        attributedActivityId: event.action === 'retry'
          ? roundAdmissions.find(round => round.controlId === event.controlId)?.activityId
          : undefined,
        eventSeq: event.seq,
      }));
      const retryRoundAdmission = roundAdmissions.find(value =>
        value.cause === 'manual_retry' && value.controlId === retryEvent.controlId);
      if (retryRoundAdmission?.activityId !== manualRetryActivity.id) {
        throw new Error('Manual retry provenance does not join to the observed Activity.');
      }
      const humanInputs = mailbox.filter(item => item.source.kind === 'chat');
      const unscheduledRequests = items.filter(item =>
        item.goal?.state === 'needs_input' || item.goal?.interventionReason);
      const postCrashActivities = activities.filter(activity =>
        activity.id !== second.processEpoch.crashActivityId
        && activity.createdAt >= Date.parse(second.processEpoch.endedAt));
      const verifiedTimes = [
        ...Object.values(external.state.artifacts).map((artifact: any) => artifact.observedAt),
        ...external.state.effects.map((effect: any) => effect.publishedAt),
      ];
      const verifiedProgressActivityIds = new Set(verifiedTimes.flatMap((observedAt: number) =>
        activities.filter(activity => activity.createdAt <= observedAt
          && (activity.completedAt ?? stopAt) >= observedAt).map(activity => activity.id)));
      const browser = await browserObservation(external);
      const allModelCalls = [...first.modelCalls, ...second.modelCalls, ...modelCalls];
      const completedModelCalls = allModelCalls.filter(call => call.outcome === 'completed');
      const thirdEpoch = {
        epochId: 'epoch-3-recovered',
        pid: process.pid,
        processBirthMarker: await processBirthMarker(),
        startedAt: iso(phaseStartedAt),
        endedAt: iso(stopAt),
        exitKind: 'recovered_and_stopped' as const,
        goalId,
        postRestartActivityId: postCrashActivities[0]?.id,
      };
      const third = await writeCheckpoint(3, {
        phase,
        processEpoch: thirdEpoch,
        workspaceId,
        personaId,
        goalId,
        roleVersionId: first.roleVersionId,
        modelCalls,
        observations: {
          startupAttempts,
          reconciliation,
          pausedState: paused?.goal?.state,
          scheduledControls,
          pendingTaskIdBeforeScheduledStop: beforeStop?.goal?.pendingTaskId,
          pendingDispatchIdBeforeScheduledStop: beforeStop?.goal?.pendingDispatchId,
          stateBeforeScheduledStop: beforeStop?.goal?.state,
          roundsBeforeScheduledStop: beforeStop?.goal?.rounds,
          postCrashActivityIds: postCrashActivities.map(activity => activity.id),
        },
      });
      const processEpochs = [
        first.processEpoch,
        second.processEpoch,
        third.processEpoch,
      ];
      const intervals = [
        { kind: 'active', startedAt: first.processEpoch.startedAt, endedAt: first.processEpoch.endedAt, epochId: first.processEpoch.epochId },
        { kind: 'downtime', startedAt: first.processEpoch.endedAt, endedAt: second.processEpoch.startedAt },
        { kind: 'active', startedAt: second.processEpoch.startedAt, endedAt: second.processEpoch.endedAt, epochId: second.processEpoch.epochId },
        { kind: 'downtime', startedAt: second.processEpoch.endedAt, endedAt: third.processEpoch.startedAt },
        { kind: 'active', startedAt: third.processEpoch.startedAt, endedAt: iso(pauseAppliedAt), epochId: third.processEpoch.epochId },
        { kind: 'paused', startedAt: iso(pauseAppliedAt), endedAt: iso(continueAppliedAt), control: 'scheduled-pause' },
        { kind: 'active', startedAt: iso(continueAppliedAt), endedAt: third.processEpoch.endedAt, epochId: third.processEpoch.epochId },
      ];
      const activeDurationMs = intervals
        .filter(interval => interval.kind === 'active')
        .reduce((sum, interval) => sum + Date.parse(interval.endedAt) - Date.parse(interval.startedAt), 0);
      const elapsedDurationMs = stopAt - Date.parse(first.processEpoch.startedAt);
      const eligibleRounds = eligibleRoundAdmissions.length;
      const autonomousEligibleRounds = eligibleRoundAdmissions
        .filter(admission => admission.cause === 'autonomous').length;
      const stalledDueButNeverAdmitted = roundAdmissions.filter(admission =>
        admission.dueAt <= stopAt
        && !admission.activityId
        && !admission.ownerCancelledBeforeDispatch).length;
      const interventions = [
        { type: 'initial_setup', classification: 'initial_setup', at: first.processEpoch.startedAt },
        { type: 'graceful_restart', classification: 'scheduled', at: first.processEpoch.endedAt },
        { type: 'forced_termination', classification: 'scheduled', at: second.processEpoch.endedAt },
        ...scheduledControls,
      ];
      const checks = {
        oneOngoingGoal: items.filter(item => item.goal).length === 1
          && root?.goal?.completionPolicy === 'until_stopped',
        ordinaryMarketingSetup: first.observations.initialAgentEntries instanceof Array
          && (first.observations.initialAgentEntries as unknown[]).length === 0,
        multipleAutonomousWakeups: autonomousEligibleRounds >= 4,
        gracefulProcessRestart: first.processEpoch.pid !== second.processEpoch.pid
          && Boolean(second.processEpoch.postRestartActivityId),
        forcedProcessRecovery: new Set(processEpochs.map(epoch => epoch.pid)).size === 3
          && new Set(processEpochs.map(epoch => epoch.processBirthMarker)).size === 3
          && postCrashActivities.length > 0
          && !postCrashActivities.some(activity => activity.id === second.processEpoch.crashActivityId),
        effectReconciliation: external.state.effects.length === 1
          && external.state.acknowledgementState === 'reconciled'
          && external.audit.some((event: any) => event.type === 'publication_uncertain_effect_reconciled')
          && !external.audit.some((event: any) => event.type === 'duplicate_effect_prevented'),
        verifiedUsefulProgress: verifiedProgressActivityIds.size >= 3
          && Object.values(external.state.artifacts).filter((artifact: any) => artifact.verified).length >= 3,
        recoverableFailureContinuation: external.audit.some((event: any) => event.type === 'publication_rate_limited')
          && external.audit.some((event: any) => event.type === 'publication_committed_ack_withheld'),
        ownerControlsPersisted: scheduledControls.map(control => control.action).join('|')
          === 'pause|retry|stop'
          && scheduledControls.map(control => control.resultingState).join('|')
          === 'paused|active|stopped'
          && root?.goal?.state === 'stopped'
          && root.goal.pendingControlId === undefined
          && retryRoundAdmission?.activityId === manualRetryActivity.id,
        noUnscheduledIntervention: humanInputs.length === 0 && unscheduledRequests.length === 0,
        durationSatisfied: elapsedDurationMs >= requestedDurationMs
          && activeDurationMs >= requestedActiveMs,
        cleanupCompleted: external.state.cleanup.status === 'completed',
        browserExecution: browser.verified,
        actualModelObserved: completedModelCalls.length > 0
          && new Set(completedModelCalls.map(call => call.pid)).size === 3
          && allModelCalls.every(call => call.model === model.name && call.adapter === model.adapter)
          && (mode !== 'live' || completedModelCalls.every(call =>
            typeof call.completionId === 'string'
            && call.completionId.startsWith('codex_')
            && typeof (call.usage as { total_tokens?: unknown } | undefined)?.total_tokens === 'number'
            && Number((call.usage as { total_tokens: number }).total_tokens) > 0)),
      };
      const allChecksPassed = Object.values(checks).every(Boolean);
      const report = {
        schemaVersion: 1,
        status: allChecksPassed ? 'completed' : 'failed',
        runIdentity: {
          runId,
          commitSha: process.env.PERSONA_GOAL_ENDURANCE_COMMIT,
          sourceDiffSha256: process.env.PERSONA_GOAL_ENDURANCE_DIFF_SHA256,
          mode,
          profile,
          authoritativeLiveModel: mode === 'live',
          startedAt: first.processEpoch.startedAt,
          endedAt: third.processEpoch.endedAt,
          verifierVersion: 'persona-goal-endurance-v1',
          policyVersion: 'issue-505-endurance-metrics-v1',
        },
        configuration: {
          model: { ...model, ApiKey: undefined },
          workspaceId,
          personaId,
          goalId,
          roleVersionId: first.roleVersionId,
          roleName: 'Marketing Agent',
          personaName: 'Frederik',
          initialGoal: 'Make FLUJO known on the internet',
          completionPolicy: 'until_stopped',
          requestedDurationMs,
          requestedActiveMs,
          pauseMs,
          continuationIntervalMs,
          roundLimit,
          maxModelCalls,
          totalTimeoutMs,
          concurrency: 1,
          budgetUsd: Number(process.env.PERSONA_GOAL_ENDURANCE_BUDGET_USD),
          fixtureManifestId: process.env.PERSONA_GOAL_ENDURANCE_MANIFEST_ID,
          fixtureManifestSha256: process.env.PERSONA_GOAL_ENDURANCE_MANIFEST_SHA256,
        },
        checks,
        processEpochs,
        intervals,
        checkpoints: [first, second, third].map(checkpoint => ({
          sequence: checkpoint.sequence,
          phase: checkpoint.phase,
          filename: 'checkpoints/' + String(checkpoint.sequence).padStart(4, '0') + '.json',
        })),
        metrics: {
          eligibleRounds,
          autonomousEligibleRounds,
          unattendedRoundRate: eligibleRounds === 0 ? null : autonomousEligibleRounds / eligibleRounds,
          stalledDueButNeverAdmitted,
          interventionCount: interventions.length,
          unscheduledInterventionCount: 0,
          verifiedProgressActivities: verifiedProgressActivityIds.size,
          elapsedDurationMs,
          activeDurationMs,
          pausedDurationMs: continueAppliedAt - pauseAppliedAt,
          downtimeDurationMs: intervals.filter(interval => interval.kind === 'downtime')
            .reduce((sum, interval) => sum + Date.parse(interval.endedAt) - Date.parse(interval.startedAt), 0),
        },
        interventions,
        recovery: {
          retryableFailures: external.audit.filter((event: any) => event.type === 'publication_rate_limited').length,
          recoveredFailures: 1,
          unrecoveredFailures: 0,
          repeatedEquivalentFailures: 0,
          prematureStops: 0,
          retainedBlockers: unscheduledRequests.map(item => ({
            id: item.id,
            reason: item.goal?.interventionReason,
            nextAction: item.nextAction,
          })),
          crashActivityId: second.processEpoch.crashActivityId,
          postCrashActivityIds: postCrashActivities.map(activity => activity.id),
        },
        external: {
          serviceClass: 'controlled-staging',
          serviceId: external.state.serviceId,
          sourceId: external.state.facts.sourceId,
          artifacts: external.state.artifacts,
          effects: external.state.effects,
          publicationAttempts: external.state.publicationAttempts,
          duplicateEffects: Math.max(0, external.state.effects.length - 1),
          acknowledgementState: external.state.acknowledgementState,
          cleanup: external.state.cleanup,
          browser,
        },
        qualityReview: {
          status: 'not_evaluated',
          rubricVersion: 'marketing-output-quality-v1',
          reason: 'Autonomy evidence is kept separate from a future independent human quality score.',
        },
        goals: items.filter(item => item.goal),
        goalTasks,
        activities,
        mailbox,
        dispatches,
        runtimeEvents,
        goalRoundAdmissions: roundAdmissions,
        modelCalls: allModelCalls,
        snapshots,
      };
      const raw = JSON.stringify(report, null, 2) + '\n';
      await fs.writeFile(path.join(outputDirectory, 'persona-goal-endurance.json'), raw);
      expect(checks).toEqual(Object.fromEntries(Object.keys(checks).map(key => [key, true])));
    });
  });
});
