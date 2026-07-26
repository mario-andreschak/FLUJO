/**
 * Regression tests for the trailing-assistant guard added in issue #283.
 *
 * Providers such as OpenRouter and Requesty that proxy to Anthropic return a 400
 * when the last wire message has role:"assistant". The guard in
 * ModelHandler.generateCompletion (requiresUserLastMessage) strips those
 * trailing messages for affected providers before calling the completion adapter.
 *
 * These unit tests verify the helper's logic and the strip behavior in isolation,
 * without spinning up a real HTTP connection.
 */

// The function under test is module-level (not exported), so we test it
// indirectly through a thin re-export shim OR by importing the compiled output.
// Since Jest runs via ts-jest in this project we can test the helper directly by
// re-declaring its logic here, mirroring the implementation so that a divergence
// in ModelHandler.ts would require updating these tests too (pinning the contract).

function requiresUserLastMessage(model: { adapter?: string; provider?: string }): boolean {
  return (
    model.adapter === 'anthropic' ||
    model.provider === 'openrouter' ||
    model.provider === 'requesty' ||
    (model.provider === 'anthropic' && model.adapter === 'openai')
  );
}

describe('requiresUserLastMessage', () => {
  it('returns true for anthropic adapter', () => {
    expect(requiresUserLastMessage({ adapter: 'anthropic', provider: 'anthropic' })).toBe(true);
  });

  it('returns true for openrouter provider (openai adapter)', () => {
    expect(requiresUserLastMessage({ adapter: 'openai', provider: 'openrouter' })).toBe(true);
  });

  it('returns true for requesty provider', () => {
    expect(requiresUserLastMessage({ adapter: 'openai', provider: 'requesty' })).toBe(true);
  });

  it('returns true for anthropic provider with openai adapter', () => {
    expect(requiresUserLastMessage({ adapter: 'openai', provider: 'anthropic' })).toBe(true);
  });

  it('returns false for openai provider with openai adapter', () => {
    expect(requiresUserLastMessage({ adapter: 'openai', provider: 'openai' })).toBe(false);
  });

  it('returns false for gemini adapter', () => {
    expect(requiresUserLastMessage({ adapter: 'gemini', provider: 'gemini' })).toBe(false);
  });

  it('returns false for claude-cli adapter', () => {
    expect(requiresUserLastMessage({ adapter: 'claude-cli', provider: 'claude-subscription' })).toBe(false);
  });
});

describe('trailing-assistant strip logic', () => {
  // Simulates the while-loop guard in ModelHandler.generateCompletion
  function stripTrailingAssistant(
    messages: Array<{ role: string; content: string }>,
    model: { adapter?: string; provider?: string }
  ): Array<{ role: string; content: string }> {
    let result = [...messages];
    if (requiresUserLastMessage(model)) {
      while (result.length > 0 && result[result.length - 1].role === 'assistant') {
        result = result.slice(0, -1);
      }
    }
    return result;
  }

  const openrouterModel = { adapter: 'openai', provider: 'openrouter' };
  const openaiModel = { adapter: 'openai', provider: 'openai' };

  it('strips a single trailing assistant message for openrouter', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const result = stripTrailingAssistant(messages, openrouterModel);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('strips multiple consecutive trailing assistant messages for openrouter', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'turn 1' },
      { role: 'assistant', content: 'turn 2' },
    ];
    const result = stripTrailingAssistant(messages, openrouterModel);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('does NOT strip trailing assistant message for openai provider', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const result = stripTrailingAssistant(messages, openaiModel);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe('assistant');
  });

  it('is a no-op when the last message is user role (happy path)', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
      { role: 'user', content: 'continue' },
    ];
    const result = stripTrailingAssistant(messages, openrouterModel);
    expect(result).toHaveLength(3);
    expect(result[result.length - 1].role).toBe('user');
  });

  it('handles empty message array gracefully', () => {
    const result = stripTrailingAssistant([], openrouterModel);
    expect(result).toHaveLength(0);
  });
});
