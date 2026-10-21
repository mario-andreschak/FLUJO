import { harnessAssessmentOperation, parseHarnessAssessment } from '@/backend/services/harness/assessment';
import { contrastHarnessCandidates } from '@/backend/services/harness/contrast';
import type { HarnessCandidate, HarnessRun } from '@/shared/types/harness';

it('judges against original execution prompts and the executed trace, including conversation context', () => {
  const run = { input: { basePrompt: 'Original task instructions', rubric: 'Follow the task and grounding requirements.' },
    caseMessages: { task: [{ role: 'user', content: 'Earlier context' }] } } as unknown as HarnessRun;
  const baseline = [{ nodeId: 'agent', text: 'Persona identity + Start + Model + FLUJO + authored prompt', hash: 'pinned' }];
  const operation = harnessAssessmentOperation(run, { id: 'task', split: 'train', input: 'Do the task', required: [], forbidden: [] },
    'Candidate output', { originalSystemPrompts: baseline, toolTrace: [] });
  expect(JSON.parse(operation.user)).toMatchObject({ originalSystemPrompts: baseline,
    originalInstructions: 'Original task instructions', executedToolTrace: [], conversation: [{ role: 'user', content: 'Earlier context' }] });
  expect(parseHarnessAssessment('{"quality":3,"compliant":false,"explanation":"Missing grounding"}')).toMatchObject({ quality: 0.75, compliance: 0 });
  expect(() => parseHarnessAssessment('{"quality":5,"compliant":true,"explanation":"bad scale"}')).toThrow();
});

it('pairs training evidence by task identity and excludes held-out outputs from contrastive learning', () => {
  const probe = { caseId: 'training', split: 'train' as const, promptHash: 'hash', output: 'before', quality: 0.5,
    compliance: 1, missing: [], violations: [], durationMs: 10, tokens: 5 };
  const parent: HarnessCandidate = { id: 'parent', prompt: 'Keep\nRemove', round: 0, scope: 'baseline', promptHash: 'parent', rationale: 'Original',
    probes: [probe, { ...probe, caseId: 'heldout', split: 'holdout', output: 'PRIVATE HOLDOUT' }] };
  const candidate: HarnessCandidate = { ...parent, id: 'candidate', prompt: 'Keep\nAdd', probes: [{ ...probe, output: 'after', quality: 1 }] };
  const contrast = contrastHarnessCandidates(parent, candidate);
  expect(contrast.instructionChange).toEqual({ added: ['Add'], removed: ['Remove'] });
  expect(contrast.pairedTasks).toHaveLength(1);
  expect(contrast.pairedTasks[0].qualityDelta).toBe(0.5);
  expect(JSON.stringify(contrast)).not.toContain('PRIVATE HOLDOUT');
});
