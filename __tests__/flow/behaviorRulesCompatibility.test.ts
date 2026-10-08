import { FlowSnapshotSchema } from '@/shared/types/enduringAgent';
import { type Flow, normalizeBehaviorRulesInput } from '@/shared/types/flow';
import {
  hashBehaviorFlow,
  snapshotBehaviorFlow,
} from '@/backend/services/enduringAgents/behaviorRevisions';
import { hashFlowExecutionSnapshot } from '@/backend/services/flow/executionSnapshot';

const rules = [{ effect: 'deny' as const, action: 'question', resource: '*' }];

function flowWith(policy: Record<string, unknown>): Flow {
  return {
    id: 'flow_policy_compat',
    name: 'Policy compatibility',
    nodes: [{
      id: 'start',
      type: 'start',
      position: { x: 0, y: 0 },
      data: { label: 'Start', type: 'start' },
    }],
    edges: [],
    ...policy,
  } as Flow;
}

describe('Flow Behavior-rule compatibility', () => {
  it('parses legacy input into canonical output while preserving extensions', () => {
    const parsed = FlowSnapshotSchema.parse({
      ...flowWith({}),
      permissionRules: rules,
      extensionField: { retained: true },
    });

    expect(parsed.behaviorRules).toEqual(rules);
    expect(parsed).not.toHaveProperty('permissionRules');
    expect((parsed as Flow & { extensionField: unknown }).extensionField)
      .toEqual({ retained: true });
  });

  it('accepts equal aliases and rejects conflicting aliases', () => {
    const equal = FlowSnapshotSchema.parse({
      ...flowWith({ behaviorRules: rules }),
      permissionRules: structuredClone(rules),
    });
    expect(equal.behaviorRules).toEqual(rules);
    expect(equal).not.toHaveProperty('permissionRules');

    expect(() => FlowSnapshotSchema.parse({
      ...flowWith({ behaviorRules: rules }),
      permissionRules: [{ effect: 'allow', action: 'question', resource: '*' }],
    })).toThrow(/behaviorRules conflicts with legacy permissionRules/);
  });

  it('validates malformed rules under both canonical and legacy keys', () => {
    expect(() => FlowSnapshotSchema.parse({
      ...flowWith({}),
      behaviorRules: [{ effect: 'deny', action: '' }],
    })).toThrow();

    expect(() => FlowSnapshotSchema.parse({
      ...flowWith({}),
      permissionRules: [{ effect: 'deny', action: '' }],
    })).toThrow();
  });

  it('canonicalizes snapshots and hashes equivalent spellings identically', () => {
    const canonical = flowWith({ behaviorRules: rules });
    const legacy = flowWith({ permissionRules: rules });

    expect(snapshotBehaviorFlow(legacy)).toEqual(snapshotBehaviorFlow(canonical));
    expect(snapshotBehaviorFlow(legacy)).not.toHaveProperty('permissionRules');
    expect(hashBehaviorFlow(legacy)).toBe(hashBehaviorFlow(canonical));
    expect(hashFlowExecutionSnapshot(legacy)).toBe(hashFlowExecutionSnapshot(canonical));
  });

  it('does not mutate compatibility input', () => {
    const legacy = flowWith({ permissionRules: rules }) as Flow & {
      permissionRules: typeof rules;
    };
    const normalized = normalizeBehaviorRulesInput(legacy);

    expect(legacy.permissionRules).toEqual(rules);
    expect(normalized.behaviorRules).toEqual(rules);
    expect(normalized).not.toHaveProperty('permissionRules');
  });
});
