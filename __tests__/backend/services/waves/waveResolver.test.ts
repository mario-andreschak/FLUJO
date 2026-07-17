import { resolveWaves, WaveResolverExecutionEntry } from '@/backend/services/waves/waveResolver';
import type { Flow, FlowNode } from '@/shared/types/flow/flow';
import type { PlannedExecution, TriggerConfig } from '@/shared/types/plannedExecution';

/* ------------------------------------------------------------------ */
/* Fixture builders                                                    */
/* ------------------------------------------------------------------ */

let seq = 0;
function node(type: string, properties: Record<string, any> = {}): FlowNode {
  seq += 1;
  return {
    id: `n${seq}`,
    position: { x: 0, y: 0 },
    data: { label: type, type, properties },
  } as FlowNode;
}

function flow(id: string, name: string, nodes: FlowNode[] = []): Flow {
  return { id, name, nodes, edges: [] };
}

/** A flow that calls one or more subflows (via subflow nodes). */
function flowWithSubflows(id: string, name: string, subflowIds: string[]): Flow {
  return flow(
    id,
    name,
    subflowIds.map((sid) => node('subflow', { subflowId: sid })),
  );
}

/** A flow that emits a signal topic. */
function flowWithSignal(id: string, name: string, topic: string): Flow {
  return flow(id, name, [node('signal', { topic })]);
}

function exec(
  id: string,
  flowId: string,
  trigger: TriggerConfig,
  overrides: Partial<PlannedExecution> = {},
): WaveResolverExecutionEntry {
  const execution: PlannedExecution = {
    id,
    name: overrides.name ?? id,
    enabled: overrides.enabled ?? true,
    flowId,
    prompt: '',
    trigger,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  return { execution, status: { nextRun: null } };
}

const schedule = (cron = '0 * * * *'): TriggerConfig => ({ type: 'schedule', cron });
const webhook = (): TriggerConfig => ({ type: 'webhook', token: 't' });
const fileWatch = (): TriggerConfig => ({ type: 'file-watch', path: '/tmp', events: ['add'] });
const onFlow = (flowId: string, on: Array<'completed' | 'error'> = ['completed']): TriggerConfig => ({
  type: 'flow-event',
  source: { flowId },
  on,
});
const onExecution = (executionId: string): TriggerConfig => ({
  type: 'flow-event',
  source: { executionId },
  on: ['completed'],
});
const onName = (flowName: string): TriggerConfig => ({
  type: 'flow-event',
  source: { flowName },
  on: ['completed'],
});
const onTopic = (topic: string): TriggerConfig => ({ type: 'flow-event', source: { topic } });

const NOW = Date.parse('2026-07-17T12:00:00.000Z');

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('resolveWaves', () => {
  test('Example 1: periodic → completion → completion is one wave, one chain', () => {
    const flows = [flow('fP', 'Planner'), flow('fC', 'Coder'), flow('fT', 'Tester')];
    const executions = [
      exec('e1', 'fP', schedule(), { name: 'T1' }),
      exec('e2', 'fC', onFlow('fP'), { name: 'T2' }),
      exec('e3', 'fT', onFlow('fC'), { name: 'T3' }),
    ];
    const res = resolveWaves({ executions, flows, now: NOW });

    expect(res.waves).toHaveLength(1);
    const wave = res.waves[0];
    expect(wave.rootExecutionIds).toEqual(['e1']);
    expect(wave.nodes.map((n) => n.executionId).sort()).toEqual(['e1', 'e2', 'e3']);
    expect(wave.edges).toEqual([
      expect.objectContaining({ fromExecutionId: 'e1', toExecutionId: 'e2', via: 'completion' }),
      expect.objectContaining({ fromExecutionId: 'e2', toExecutionId: 'e3', via: 'completion' }),
    ]);
    // Timing modes.
    const byId = Object.fromEntries(wave.nodes.map((n) => [n.executionId, n]));
    expect(byId.e1.timing.mode).toBe('timeline');
    expect(byId.e1.isRoot).toBe(true);
    expect(byId.e2.timing).toMatchObject({ mode: 'event', via: 'completion' });
    expect(byId.e2.isRoot).toBe(false);
    expect(res.orphans).toHaveLength(0);
  });

  test('Example 2: two periodic roots + signal chain → two waves', () => {
    const flows = [
      flowWithSignal('fP', 'Planner', 'planner-done'),
      flowWithSignal('fC', 'Coder', 'coder-done'),
      flow('fT', 'Tester'),
      flow('fR', 'Release'),
    ];
    const executions = [
      exec('e1', 'fP', schedule(), { name: 'T1' }),
      exec('e2', 'fC', onTopic('planner-done'), { name: 'T2' }),
      exec('e3', 'fT', onTopic('coder-done'), { name: 'T3' }),
      exec('e4', 'fR', schedule('0 0 * * *'), { name: 'T4' }),
    ];
    const res = resolveWaves({ executions, flows, now: NOW });

    expect(res.waves).toHaveLength(2);
    const waveP = res.waves.find((w) => w.id === 'e1')!;
    const waveR = res.waves.find((w) => w.id === 'e4')!;
    expect(waveP.nodes.map((n) => n.executionId).sort()).toEqual(['e1', 'e2', 'e3']);
    expect(waveP.edges.every((e) => e.via === 'signal')).toBe(true);
    expect(waveP.edges).toEqual([
      expect.objectContaining({ fromExecutionId: 'e1', toExecutionId: 'e2', via: 'signal', topic: 'planner-done' }),
      expect.objectContaining({ fromExecutionId: 'e2', toExecutionId: 'e3', via: 'signal', topic: 'coder-done' }),
    ]);
    expect(waveR.nodes.map((n) => n.executionId)).toEqual(['e4']);
    expect(waveR.edges).toHaveLength(0);
  });

  test('Example 3: subflows, webhook root, and a shared downstream across roots', () => {
    const flows = [
      flowWithSubflows('fP', 'Planner', ['fE']),
      flowWithSubflows('fC', 'Coder', ['fE']),
      flow('fT', 'Tester'),
      flow('fE', 'Explorer'),
      flowWithSubflows('fTr', 'Triage', ['fE', 'fP']),
    ];
    const executions = [
      exec('e1', 'fP', schedule(), { name: 'T1' }),
      exec('e2', 'fC', onFlow('fP'), { name: 'T2' }),
      exec('e3', 'fT', onFlow('fC'), { name: 'T3' }),
      exec('e4', 'fP', schedule('0 0 * * *'), { name: 'T4-secondPlanner' }),
      exec('e5', 'fTr', webhook(), { name: 'T5-Triage' }),
    ];
    const res = resolveWaves({ executions, flows, now: NOW });

    // Roots: e1, e4 (both bound to Planner), e5 (webhook).
    const waveIds = res.waves.map((w) => w.id).sort();
    expect(waveIds).toEqual(['e1', 'e4', 'e5']);

    // Shared downstream e2/e3 appear under BOTH Planner roots.
    const w1 = res.waves.find((w) => w.id === 'e1')!;
    const w4 = res.waves.find((w) => w.id === 'e4')!;
    expect(w1.nodes.map((n) => n.executionId).sort()).toEqual(['e1', 'e2', 'e3']);
    expect(w4.nodes.map((n) => n.executionId).sort()).toEqual(['e2', 'e3', 'e4']);

    // Subflow trees.
    const e1Node = w1.nodes.find((n) => n.executionId === 'e1')!;
    expect(e1Node.subflows.map((s) => s.flowName)).toEqual(['Explorer']);

    const w5 = res.waves.find((w) => w.id === 'e5')!;
    const e5Node = w5.nodes[0];
    expect(e5Node.triggerKind).toBe('webhook');
    expect(e5Node.timing.mode).toBe('fixed');
    // Triage → [Explorer, Planner]; Planner → [Explorer] (nested).
    const names = e5Node.subflows.map((s) => s.flowName).sort();
    expect(names).toEqual(['Explorer', 'Planner']);
    const planner = e5Node.subflows.find((s) => s.flowName === 'Planner')!;
    expect(planner.children.map((c) => c.flowName)).toEqual(['Explorer']);
  });

  test('topic linking works when a subflow (not the parent) emits the topic', () => {
    const flows = [
      flowWithSubflows('fParent', 'Parent', ['fChild']),
      flowWithSignal('fChild', 'Child', 'child-topic'),
      flow('fCons', 'Consumer'),
    ];
    const executions = [
      exec('eProd', 'fParent', schedule()),
      exec('eCons', 'fCons', onTopic('child-topic')),
    ];
    const res = resolveWaves({ executions, flows, now: NOW });
    const wave = res.waves.find((w) => w.id === 'eProd')!;
    expect(wave.edges).toEqual([
      expect.objectContaining({ fromExecutionId: 'eProd', toExecutionId: 'eCons', via: 'signal', topic: 'child-topic' }),
    ]);
  });

  test('completion linking by executionId / flowName carries the on filter', () => {
    const flows = [flow('fA', 'Alpha'), flow('fB', 'Beta'), flow('fC', 'Gamma')];
    const executions = [
      exec('src', 'fA', schedule()),
      exec('byExec', 'fB', onExecution('src')),
      exec('byName', 'fC', onName('Alpha', )),
    ];
    // give byName an explicit error filter
    executions[2].execution.trigger = { type: 'flow-event', source: { flowName: 'Alpha' }, on: ['error'] };
    const res = resolveWaves({ executions, flows, now: NOW });
    const wave = res.waves.find((w) => w.id === 'src')!;
    expect(wave.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromExecutionId: 'src', toExecutionId: 'byExec', via: 'completion', on: ['completed'] }),
        expect.objectContaining({ fromExecutionId: 'src', toExecutionId: 'byName', via: 'completion', on: ['error'] }),
      ]),
    );
  });

  test('recursion is capped: cycle flagged and traversal terminates', () => {
    const flows = [flow('fA', 'A'), flow('fB', 'B')];
    const executions = [
      exec('eR', 'fA', schedule()),        // root, bound to fA
      exec('eA', 'fA', onFlow('fB')),      // runs fA when fB completes
      exec('eB', 'fB', onFlow('fA')),      // runs fB when fA completes
    ];
    const res = resolveWaves({ executions, flows, now: NOW });
    // Single root eR; the wave contains the whole cycle and is flagged.
    const wave = res.waves.find((w) => w.id === 'eR')!;
    expect(wave.nodes.map((n) => n.executionId).sort()).toEqual(['eA', 'eB', 'eR']);
    expect(wave.hasCycle).toBe(true);
  });

  test('orphan: a flow-event source matching nothing is reported, not charted', () => {
    const flows = [flow('fA', 'A')];
    const executions = [
      exec('root', 'fA', schedule()),
      exec('orphan', 'fA', onFlow('does-not-exist')),
    ];
    const res = resolveWaves({ executions, flows, now: NOW });
    expect(res.orphans.map((o) => o.executionId)).toEqual(['orphan']);
    const allWaveNodeIds = res.waves.flatMap((w) => w.nodes.map((n) => n.executionId));
    expect(allWaveNodeIds).not.toContain('orphan');
  });

  test('missing flow / missing subflow are flagged without throwing', () => {
    const flows = [flowWithSubflows('fP', 'Planner', ['missingFlow'])];
    const executions = [
      exec('e1', 'fP', schedule()),
      exec('e2', 'ghostFlow', schedule()), // bound flow not present
    ];
    const res = resolveWaves({ executions, flows, now: NOW });
    const e1 = res.waves.find((w) => w.id === 'e1')!.nodes[0];
    expect(e1.subflows[0]).toMatchObject({ flowId: 'missingFlow', missing: true });
    const e2 = res.waves.find((w) => w.id === 'e2')!.nodes[0];
    expect(e2.flowName).toBeUndefined();
  });

  test('deterministic: shuffled inputs produce identical output', () => {
    const flows = [
      flowWithSignal('fP', 'Planner', 'planner-done'),
      flow('fC', 'Coder'),
      flow('fT', 'Tester'),
    ];
    const base = [
      exec('e1', 'fP', schedule()),
      exec('e2', 'fC', onTopic('planner-done')),
      exec('e3', 'fT', onFlow('fC')),
    ];
    const first = resolveWaves({ executions: base, flows, now: NOW });
    const shuffled = resolveWaves({
      executions: [base[2], base[0], base[1]],
      flows: [flows[2], flows[0], flows[1]],
      now: NOW,
    });
    expect(JSON.stringify(shuffled.waves)).toEqual(JSON.stringify(first.waves));
    expect(JSON.stringify(shuffled.orphans)).toEqual(JSON.stringify(first.orphans));
  });

  test('connected-component grouping merges shared-downstream roots into one wave', () => {
    const flows = [flow('fP', 'Planner'), flow('fC', 'Coder')];
    const executions = [
      exec('e1', 'fP', schedule()),
      exec('e4', 'fP', schedule('0 0 * * *')),
      exec('e2', 'fC', onFlow('fP')),
    ];
    const res = resolveWaves({ executions, flows, now: NOW, grouping: 'connected-component' });
    expect(res.waves).toHaveLength(1);
    expect(res.waves[0].rootExecutionIds.sort()).toEqual(['e1', 'e4']);
    expect(res.waves[0].nodes.map((n) => n.executionId).sort()).toEqual(['e1', 'e2', 'e4']);
  });
});
