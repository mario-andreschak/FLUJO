import { personaChatRoutingMetadata } from '@/frontend/components/Chat/personaChatTarget';

describe('Persona Chat routing metadata', () => {
  it('sends the selected named Behavior with the Persona id', () => {
    expect(personaChatRoutingMetadata({
      personaId: 'persona-ada',
      personaBehaviorSlotKey: 'research',
    })).toEqual({
      personaId: 'persona-ada',
      behaviorSlotKey: 'research',
    });
  });

  it('sends Main role as the primary Behavior and never targets a Flow chat', () => {
    expect(personaChatRoutingMetadata({
      personaId: 'persona-ada',
      personaBehaviorSlotKey: 'primary',
    })).toEqual({
      personaId: 'persona-ada',
      behaviorSlotKey: 'primary',
    });
    expect(personaChatRoutingMetadata({})).toEqual({});
  });
});
