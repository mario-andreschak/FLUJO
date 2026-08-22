import { PERSONA_INGRESS_MATRIX } from '../personaIngressMatrix';
import { runPersonaSoak } from './soakHarness';
import { VirtualPersonaRuntimeClock } from './virtualClock';
import { generatePersonaSoakWorkload } from './workloadGenerator';

jest.setTimeout(165 * 60 * 1_000);

describe('deterministic Persona soak harness', () => {
  it('generates byte-identical seeded schedules with weekly ingress coverage', () => {
    const options = { days: 28, activitiesPerDay: 20, seed: 459 };
    const first = generatePersonaSoakWorkload(options);
    expect(JSON.stringify(first)).toBe(JSON.stringify(generatePersonaSoakWorkload(options)));
    expect(first).toHaveLength(560);
    for (let week = 0; week < 4; week += 1) {
      const labels = new Set(first.filter((activity) => activity.day > week * 7 && activity.day <= (week + 1) * 7).map((activity) => activity.ingress.label));
      expect(labels).toEqual(new Set(PERSONA_INGRESS_MATRIX.map((entry) => entry.label)));
    }
  });

  it('runs quick or full simulated time and enforces runtime health invariants', async () => {
    const quick = process.env.PERSONA_SOAK_FULL !== '1';
    const days = Number(process.env.PERSONA_SOAK_DAYS ?? (quick ? 3 : 28));
    const activitiesPerDay = Number(process.env.PERSONA_SOAK_ACTIVITIES_PER_DAY ?? (quick ? 5 : 20));
    const summary = await runPersonaSoak({
      days,
      activitiesPerDay,
      seed: Number(process.env.PERSONA_SOAK_SEED ?? 459),
      outputDirectory: process.env.PERSONA_SOAK_OUTPUT,
      gatingMode: 'enforce',
      withLearning: process.env.PERSONA_SOAK_WITH_LEARNING === '1',
    });
    expect(summary.activities).toBe(days * activitiesPerDay);
    expect(summary.splitBrainCount).toBe(0);
    expect(summary.strandedLeaseCount).toBe(0);
    expect(summary.stuckPersonaCount).toBe(0);
    expect(summary.runtimeEvidence).toMatchObject({
      persistedActivities: expect.any(Number),
      persistedMailboxItems: expect.any(Number),
      persistedLeaseAcquisitions: expect.any(Number),
      modelCalls: expect.any(Number),
    });
    expect(summary.runtimeEvidence.persistedActivities).toBeGreaterThanOrEqual(summary.activities);
    expect(summary.runtimeEvidence.persistedMailboxItems).toBeGreaterThanOrEqual(summary.activities);
    expect(summary.runtimeEvidence.persistedLeaseAcquisitions).toBeGreaterThanOrEqual(summary.activities);
    expect(summary.runtimeEvidence.modelCalls).toBeGreaterThan(0);
    expect(summary.metrics.every((metric) => metric.recallP95Ms > 0)).toBe(true);
    expect(summary.metrics.every((metric) => metric.eventAppendP95Ms > 0)).toBe(true);
    expect(summary.criteria.filter((criterion) => criterion.status === 'failed')).toEqual([]);
  });

  it('absorbs real restart windows without losing deterministic timer order', async () => {
    const clock = new VirtualPersonaRuntimeClock(0);
    const order: number[] = [];
    clock.setTimer(() => order.push(1), 5);
    clock.setTimer(() => order.push(2), 5);
    await clock.absorbRealTime(5);
    expect(order).toEqual([1, 2]);
  });
});
