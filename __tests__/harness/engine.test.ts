import { HarnessInputSchema, harnessCallLimit, type HarnessCandidate, type HarnessInput, type HarnessRun } from '@/shared/types/harness';
import { acceptHarnessProposal, nextHarnessOperation, promptHash } from '@/backend/services/harness/engine';
import { decideHarnessAdoption, harnessFrontier, scoreHarnessOutput, selectHarnessCandidate } from '@/backend/services/harness/evaluation';
import { harnessModelRoute } from '@/shared/harnessModelPolicy';
import type { Model } from '@/shared/types/model';

const input: HarnessInput = {
  name: 'Support', domain: 'support', modelId: 'luna', basePrompt: 'Very long original baseline instructions', rounds: 1, reuseLessons: true,
  cases: [
    { id: 't1', split: 'train', input: 'First training request', required: ['problem'], forbidden: ['done'] },
    { id: 't2', split: 'train', input: 'Second training request', required: ['action'], forbidden: ['sent'] },
    { id: 'h1', split: 'holdout', input: 'HOLDOUT_INPUT_SECRET_ONE', required: ['HOLDOUT_CHECK_SECRET'], forbidden: ['fixed'] },
    { id: 'h2', split: 'holdout', input: 'HOLDOUT_INPUT_SECRET_TWO', required: ['request'], forbidden: ['shipped'] },
  ],
};

function candidate(id: string, prompt: string, quality: number, compliance = 1): HarnessCandidate {
  return { id, prompt, promptHash: promptHash(prompt), round: id === 'baseline' ? 0 : 1,
    scope: id === 'baseline' ? 'baseline' : 'general', rationale: '',
    probes: input.cases.filter(item => item.split === 'train').map(item => ({ caseId: item.id,
      split: 'train', promptHash: promptHash(prompt), output: 'Training output', quality, compliance,
      missing: [], violations: [], durationMs: 10, tokens: 8 })),
  };
}

function run(): HarnessRun {
  return { schemaVersion: 1, id: 'run', createdAt: 1, updatedAt: 1, status: 'pending', input: structuredClone(input),
    model: { id: 'luna', name: 'gpt-6-luna', adapter: 'codex-cli', authentication: 'codex-subscription' }, modelFingerprint: 'fixed',
    candidates: [candidate('baseline', input.basePrompt, 0.5)], lessons: [], frontierIds: [], callsStarted: 0, callsCompleted: 0,
    totalTokens: 0, unknownUsageCalls: 0, modelTimeMs: 0 };
}

describe('Harness experiment evidence boundary', () => {
  it('rejects duplicate tasks across splits and dynamic prompt authority', () => {
    const duplicated = structuredClone(input);
    duplicated.cases[2].input = '  FIRST   training request ';
    expect(HarnessInputSchema.safeParse(duplicated).success).toBe(false);
    expect(HarnessInputSchema.safeParse({ ...input, basePrompt: '${tool:bash__run}' }).success).toBe(false);
    expect(HarnessInputSchema.safeParse({ ...input, basePrompt: '${global:SECRET}' }).success).toBe(false);
    expect(HarnessInputSchema.safeParse({ ...input, basePrompt: '@conversation[other].name' }).success).toBe(false);
  });

  it('does not treat a forbidden-output violation as an acceptable quality trade-off', () => {
    const baseline = candidate('baseline', 'Original', 0.5);
    const unsafe = candidate('unsafe', 'X', 1, 0);
    const reliable = candidate('reliable', 'Better', 0.75);
    expect(harnessFrontier([baseline, unsafe, reliable]).map(item => item.id)).toContain('unsafe');
    expect(selectHarnessCandidate([baseline, unsafe, reliable]).id).toBe('reliable');
  });

  it('keeps Pareto trade-offs and blocks per-example regressions hidden by averages', () => {
    const baseline = candidate('baseline', 'Baseline', 0.5);
    const faster = candidate('short', 'S', 0.5);
    const better = candidate('better', 'Longer instructions', 1);
    expect(harnessFrontier([baseline, faster, better]).map(item => item.id)).toEqual(['short', 'better']);
    const regressed = candidate('regressed', 'R', 1);
    regressed.probes[0].quality = 0;
    expect(selectHarnessCandidate([baseline, regressed]).id).toBe('baseline');
  });

  it('proposes and composes without exposing held-out data, then freezes selection', () => {
    const experiment = run();
    for (const scope of ['general', 'domain', 'composed'] as const) {
      const operation = nextHarnessOperation(experiment)!;
      expect(operation.kind).toBe('propose');
      expect(operation.user).not.toContain('HOLDOUT_');
      expect(operation.user).not.toContain('"split":"holdout"');
      if (operation.kind !== 'propose') throw new Error('Expected proposal');
      expect(operation.scope).toBe(scope);
      acceptHarnessProposal(experiment, operation, JSON.stringify({ prompt: `${scope} instructions`, rationale: 'Observed training improvement' }));
      const child = experiment.candidates.at(-1)!;
      child.probes = candidate(child.id, child.prompt, 1).probes;
    }
    const heldout = nextHarnessOperation(experiment)!;
    expect(heldout.kind).toBe('probe');
    expect(heldout.system).toBe(input.basePrompt);
    expect(heldout.user).toBe('HOLDOUT_INPUT_SECRET_ONE');
    const frozen = experiment.selectedId;
    // Even contradictory later evidence cannot reopen the selection loop.
    experiment.candidates[1].probes.push({ ...experiment.candidates[1].probes[0], caseId: 'h1', split: 'holdout', quality: 0 });
    nextHarnessOperation(experiment);
    expect(experiment.selectedId).toBe(frozen);
  });

  it('refuses model-generated bindings instead of upgrading tool authority', () => {
    const experiment = run();
    const operation = nextHarnessOperation(experiment)!;
    if (operation.kind !== 'propose') throw new Error('Expected proposal');
    expect(() => acceptHarnessProposal(experiment, operation, JSON.stringify({ prompt: '${resource:files__file://secret}', rationale: 'Read more' }))).toThrow();
    expect(experiment.candidates).toHaveLength(1);
  });

  it('requires complete held-out evidence and refuses a single held-out regression', () => {
    const baseline = candidate('baseline', 'Long baseline', 0.5), selected = candidate('selected', 'Short', 1);
    expect(decideHarnessAdoption(baseline, selected).eligible).toBe(false);
    for (const c of [baseline, selected]) {
      for (const example of input.cases.filter(item => item.split === 'holdout')) {
        c.probes.push({ ...c.probes[0], caseId: example.id, split: 'holdout', quality: 1 });
      }
    }
    expect(decideHarnessAdoption(baseline, selected).eligible).toBe(true);
    selected.probes.at(-1)!.quality = 0.5;
    expect(decideHarnessAdoption(baseline, selected).eligible).toBe(false);
  });

  it('scores explicit text checks without calling a model judge', () => {
    expect(scoreHarnessOutput(input.cases[0], 'The PROBLEM is described.')).toMatchObject({ quality: 1, compliance: 1 });
    expect(scoreHarnessOutput(input.cases[0], 'Problem done')).toMatchObject({ quality: 1, compliance: 0, violations: ['done'] });
    expect(harnessCallLimit(input)).toBe(16);
  });
});

describe('Harness model routing policy', () => {
  const base: Model = { id: 'm', name: 'gpt-6-luna', ApiKey: '', provider: 'codex', adapter: 'codex-cli' };
  it.each(['gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-terra'])('allows %s only through keyless Codex', name => {
    expect(harnessModelRoute({ ...base, name })).toBe('codex-subscription');
    expect(harnessModelRoute({ ...base, name, ApiKey: 'api-key' })).toBeNull();
    expect(harnessModelRoute({ ...base, name, baseUrl: 'https://proxy.example' })).toBeNull();
  });
  it.each(['gpt-6-astra', 'claude-sonnet', 'claude-opus', 'gemini-4-argon'])('blocks %s', name => {
    expect(harnessModelRoute({ ...base, name })).toBeNull();
    expect(harnessModelRoute({ ...base, name: `vendor/${name}:free`, provider: 'openrouter', adapter: 'openai' })).toBeNull();
  });
  it('blocks opaque routing and paid Sol/Terra while accepting explicit approved OpenRouter models', () => {
    const router: Model = { ...base, provider: 'openrouter', adapter: 'openai', ApiKey: 'key', baseUrl: 'https://openrouter.ai/api/v1' };
    for (const name of ['openrouter/free', 'openrouter/auto', 'openai/gpt-6-sol', 'openai/gpt-5.6-terra']) expect(harnessModelRoute({ ...router, name })).toBeNull();
    expect(harnessModelRoute({ ...router, name: 'deepseek/deepseek-chat' })).toBe('openrouter');
    expect(harnessModelRoute({ ...router, name: 'deepseek/deepseek-chat:free' })).toBe('openrouter');
    expect(harnessModelRoute({ ...router, name: 'deepseek/deepseek-chat', baseUrl: 'https://other.example/api/v1' })).toBeNull();
    expect(harnessModelRoute({ ...router, name: 'deepseek/deepseek-chat', adapter: 'openrouter-agent' })).toBeNull();
  });
});
