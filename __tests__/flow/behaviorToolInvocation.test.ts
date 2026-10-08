import {
  buildBehaviorToolDefinitions,
  buildBehaviorToolRegistry,
} from '@/backend/execution/flow/handlers/behaviorToolInvocation';

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
});
