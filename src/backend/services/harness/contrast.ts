import type { HarnessCandidate } from '@/shared/types/harness';

/** Paired execution evidence, never held-out traces. A delta is evidence, not proof of causality. */
export function contrastHarnessCandidates(parent: HarnessCandidate, candidate: HarnessCandidate) {
  const prior = parent.prompt.split('\n'), next = candidate.prompt.split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(prior.length, next.length) && prior[prefix] === next[prefix]) prefix++;
  while (suffix < Math.min(prior.length, next.length) - prefix
    && prior[prior.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  // One exact replacement hunk preserves ordering and duplicate lines. A set
  // difference incorrectly reports no change for reordered/repeated instructions.
  return { parentId: parent.id, candidateId: candidate.id,
    instructionChange: { added: next.slice(prefix, next.length - suffix), removed: prior.slice(prefix, prior.length - suffix) },
    pairedTasks: parent.probes.filter(probe => probe.split === 'train').flatMap(before => {
      const after = candidate.probes.find(probe => probe.split === 'train' && probe.caseId === before.caseId);
      return after ? [{ caseId: before.caseId, qualityDelta: after.quality - before.quality,
        complianceDelta: after.compliance - before.compliance,
        before: { output: before.output.slice(0, 3000), outputTruncated: before.output.length > 3000, tools: before.toolTrace, explanation: before.evaluatorReason },
        after: { output: after.output.slice(0, 3000), outputTruncated: after.output.length > 3000, tools: after.toolTrace, explanation: after.evaluatorReason },
        tokens: [before.tokens, after.tokens], durationMs: [before.durationMs, after.durationMs] }] : [];
    }),
  };
}
