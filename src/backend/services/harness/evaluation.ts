import type { HarnessCandidate, HarnessCase, HarnessProbe } from '@/shared/types/harness';

export function scoreHarnessOutput(example: HarnessCase, output: string) {
  const normalized = output.normalize('NFKC').toLowerCase();
  const includes = (value: string) => normalized.includes(value.normalize('NFKC').toLowerCase());
  const missing = example.required.filter(value => !includes(value));
  const violations = example.forbidden.filter(includes);
  return {
    quality: (example.required.length - missing.length) / example.required.length,
    compliance: violations.length ? 0 : 1,
    missing,
    violations,
  };
}

export function harnessMetrics(candidate: HarnessCandidate, split: HarnessCase['split']) {
  const probes = candidate.probes.filter(probe => probe.split === split);
  return {
    count: probes.length,
    quality: probes.length ? probes.reduce((sum, probe) => sum + probe.quality, 0) / probes.length : 0,
    compliance: probes.length ? probes.reduce((sum, probe) => sum + probe.compliance, 0) / probes.length : 0,
    promptChars: candidate.prompt.length,
  };
}

/** Preserve trade-offs instead of hiding compliance inside a scalar reward. */
export function harnessFrontier(candidates: HarnessCandidate[]): HarnessCandidate[] {
  return candidates.filter(candidate => {
    const value = harnessMetrics(candidate, 'train');
    return !candidates.some(other => {
      const metric = harnessMetrics(other, 'train');
      return metric.quality >= value.quality && metric.compliance >= value.compliance
        && metric.promptChars <= value.promptChars
        && (metric.quality > value.quality || metric.compliance > value.compliance || metric.promptChars < value.promptChars);
    });
  });
}

export function noProbeRegressions(baseline: HarnessProbe[], candidate: HarnessProbe[]): boolean {
  return baseline.length > 0 && baseline.length === candidate.length && baseline.every(before => {
    const after = candidate.find(item => item.caseId === before.caseId && item.split === before.split);
    return after && after.quality >= before.quality && after.compliance === 1;
  });
}

/** Selection sees training only. Tie-breaking is fixed before any holdout is run. */
export function selectHarnessCandidate(candidates: HarnessCandidate[]): HarnessCandidate {
  const baseline = candidates[0];
  const train = baseline.probes.filter(probe => probe.split === 'train');
  const eligible = candidates.filter(candidate => candidate.id === baseline.id || noProbeRegressions(
    train, candidate.probes.filter(probe => probe.split === 'train'),
  ));
  return [...harnessFrontier(eligible)].sort((a, b) => {
    const x = harnessMetrics(a, 'train'), y = harnessMetrics(b, 'train');
    return Math.min(y.quality, y.compliance) - Math.min(x.quality, x.compliance)
      || (y.quality + y.compliance) - (x.quality + x.compliance)
      || x.promptChars - y.promptChars
      || candidates.indexOf(a) - candidates.indexOf(b);
  })[0] ?? baseline;
}

export function decideHarnessAdoption(baseline: HarnessCandidate, selected: HarnessCandidate) {
  const reasons: string[] = [];
  if (baseline.id === selected.id || baseline.prompt === selected.prompt) reasons.push('The baseline remains the best supported choice.');
  for (const split of ['train', 'holdout'] as const) {
    if (!noProbeRegressions(baseline.probes.filter(probe => probe.split === split), selected.probes.filter(probe => probe.split === split))) {
      reasons.push(`${split === 'train' ? 'Training' : 'Held-out'} checks regressed, were incomplete, or violated a forbidden-output check.`);
    }
  }
  const before = harnessMetrics(baseline, 'train'), after = harnessMetrics(selected, 'train');
  if (!(after.quality > before.quality || after.compliance > before.compliance || after.promptChars < before.promptChars)) {
    reasons.push('No measured training improvement in required checks, forbidden-output checks, or prompt length.');
  }
  const eligible = reasons.length === 0;
  if (eligible) reasons.push('Training improved and no per-example check regressed on the held-out set. Review the outputs before creating an agent.');
  return { eligible, reasons };
}
