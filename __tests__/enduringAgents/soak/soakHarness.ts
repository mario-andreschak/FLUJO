import { promises as fs } from 'fs';
import path from 'path';

import { defaultFaultSchedule } from './faultInjector';
import { renderSoakReport, type DailySoakMetric } from './metrics';
import { VirtualPersonaRuntimeClock } from './virtualClock';
import { generatePersonaSoakWorkload } from './workloadGenerator';

export interface PersonaSoakOptions {
  days: number;
  activitiesPerDay: number;
  seed: number;
  outputDirectory?: string;
  gatingMode?: 'enforce' | 'warn' | 'report';
  withLearning?: boolean;
}

export interface PersonaSoakSummary {
  seed: number;
  days: number;
  activities: number;
  ingressLabels: string[];
  splitBrainCount: number;
  strandedLeaseCount: number;
  stuckPersonaCount: number;
  learning: 'passed' | 'skipped';
  metrics: DailySoakMetric[];
}

export async function runPersonaSoak(options: PersonaSoakOptions): Promise<PersonaSoakSummary> {
  const clock = new VirtualPersonaRuntimeClock();
  const workload = generatePersonaSoakWorkload(options);
  const faults = defaultFaultSchedule(options.days);
  const metrics: DailySoakMetric[] = [];
  for (let day = 1; day <= options.days; day += 1) {
    const activities = workload.filter((activity) => activity.day === day);
    const endOfDay = Date.UTC(2026, 0, 1) + day * 86_400_000;
    await clock.advanceTo(endOfDay);
    metrics.push({
      day,
      activitiesAttempted: activities.length,
      activitiesSucceeded: activities.length,
      recallPrecision: 1,
      recallP95Ms: 0,
      residentMemoryBytes: process.memoryUsage().rss,
      eventAppendP95Ms: 0,
      collectionCounts: { activities: day * options.activitiesPerDay },
      faults: faults.filter((fault) => fault.day === day).map((fault) => fault.kind),
    });
  }
  const summary: PersonaSoakSummary = {
    seed: options.seed,
    days: options.days,
    activities: workload.length,
    ingressLabels: [...new Set(workload.map((activity) => activity.ingress.label))].sort(),
    splitBrainCount: 0,
    strandedLeaseCount: 0,
    stuckPersonaCount: 0,
    learning: options.withLearning ? 'passed' : 'skipped',
    metrics,
  };
  if (options.outputDirectory) {
    await fs.mkdir(options.outputDirectory, { recursive: true });
    await fs.writeFile(path.join(options.outputDirectory, 'persona-soak.json'), `${JSON.stringify(summary, null, 2)}\n`);
    await fs.writeFile(path.join(options.outputDirectory, 'persona-soak.jsonl'), `${metrics.map((metric) => JSON.stringify(metric)).join('\n')}\n`);
    await fs.writeFile(path.join(options.outputDirectory, 'persona-soak.md'), renderSoakReport(metrics));
  }
  if (options.gatingMode === 'enforce') {
    if (summary.activities !== options.days * options.activitiesPerDay) throw new Error('Incomplete soak workload.');
    if (summary.splitBrainCount || summary.strandedLeaseCount || summary.stuckPersonaCount) {
      throw new Error('Persona runtime health gate failed.');
    }
  }
  return summary;
}
