import type { HarnessCandidate } from '@/shared/types/harness';

/** Paired execution evidence, never held-out traces. A delta is evidence, not proof of causality. */
export function contrastHarnessCandidates(parent: HarnessCandidate, candidate: HarnessCandidate) {
  const prior = new Set(parent.prompt.split('\n'));
  const next = new Set(candidate.prompt.split('\n'));
  return { parentId: parent.id, candidateId: candidate.id,
    instructionChange: { added: [...next].filter(line => !prior.has(line)), removed: [...prior].filter(line => !next.has(line)) },
    pairedTasks: parent.probes.filter(probe => probe.split === 'train').flatMap(before => {
      const after = candidate.probes.find(probe => probe.split === 'train' && probe.caseId === before.caseId);
      return after ? [{ caseId: before.caseId, qualityDelta: after.quality - before.quality,
        complianceDelta: after.compliance - before.compliance,
        before: { output: before.output.slice(0, 3000), tools: before.toolTrace, explanation: before.evaluatorReason },
        after: { output: after.output.slice(0, 3000), tools: after.toolTrace, explanation: after.evaluatorReason },
        tokens: [before.tokens, after.tokens], durationMs: [before.durationMs, after.durationMs] }] : [];
    }),
  };
}
