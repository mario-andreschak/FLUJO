import {
  buildBehaviorToolDefinitions,
  buildBehaviorToolRegistry,
  executeBehaviorToolCall,
} from '@/backend/execution/flow/handlers/behaviorToolInvocation';
import type { SharedState } from '@/backend/execution/flow/types';

const conversationStates = new Map<string, SharedState>();
const runFlowMock = jest.fn();
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates } }));
jest.mock('@/backend/execution/flow/runFlow', () => ({ runFlow: (...args: unknown[]) => runFlowMock(...args) }));

beforeEach(() => {
  conversationStates.clear();
  runFlowMock.mockReset();
});

describe('Persona Behavior tool registry', () => {
  it('keeps platform memory maintenance internal while advertising ordinary Behaviors', () => {
    const registry = buildBehaviorToolRegistry({
      personaId: 'persona_test',
      behaviors: [
        {
          ref: 'behavior_primary',
          slotKey: 'primary',
          name: 'Primary',
        },
        {
          ref: 'behavior_maintenance',
          slotKey: 'maintain_memory',
          name: 'Maintain memory',
        },
        {
          ref: 'behavior_research',
          slotKey: 'research',
          name: 'Research',
        },
      ],
      excludeBehaviorId: 'behavior_primary',
    });

    expect(Object.values(registry).map((target) => target.behaviorId))
      .toEqual(['behavior_research']);
    expect(buildBehaviorToolDefinitions(registry)).toEqual([
      expect.objectContaining({ name: expect.stringMatching(/^call_behavior_research_/) }),
    ]);
  });

  it.each([
    { executionExtensionOwned: true },
    { executionExtensionContext: {} },
  ])('refuses a protected synthetic Behavior call before pinning or starting a child', async protectedFields => {
    conversationStates.set('parent', {
      conversationId: 'parent',
      behaviorToolRegistry: {
        call_behavior_research: { personaId: 'persona', behaviorId: 'research', name: 'Research', description: 'Research' },
      },
      ...protectedFields,
    } as unknown as SharedState);

    await expect(executeBehaviorToolCall('call_behavior_research', { task: 'private input' }, { conversationId: 'parent' }))
      .resolves.toEqual({ success: false, error: 'execution_subflow_child_authority_required' });
    expect(runFlowMock).not.toHaveBeenCalled();
  });
});
