import { ToolHandler } from '@/backend/execution/flow/handlers/ToolHandler';
import { ToolDefinition } from '@/backend/execution/flow/types';
import { ToolPreparationInput, ToolPreparationResult } from '@/backend/execution/flow/types/toolHandler';

// Narrow the Result discriminated union and fail loudly if preparation errored.
const prepared = (input: ToolPreparationInput): ToolPreparationResult => {
  const result = ToolHandler.prepareTools(input);
  if (!result.success) {
    throw new Error(`prepareTools failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
};

/**
 * Deterministic tool ordering (#89).
 *
 * The serialized tool block is a large fixed prefix re-sent on every stateless
 * Chat Completions turn. Providers auto-cache long identical prefixes and bill
 * the re-read at a discount — but only while the bytes are byte-identical
 * turn-to-turn. MCP-node iteration + per-server listing order is not guaranteed
 * stable across reconnects/re-listing, so prepareTools canonically sorts tools
 * by their (namespaced, unique) name. These tests assert that any input order
 * yields the same output order, so the prefix keeps hitting the cache.
 */
const tool = (name: string): ToolDefinition => ({
  name,
  description: `desc for ${name}`,
  inputSchema: { type: 'object', properties: {} },
});

const namesOf = (tools: readonly { function: { name: string } }[]) =>
  tools.map(t => t.function.name);

describe('ToolHandler.prepareTools deterministic ordering (#89)', () => {
  it('sorts tools by name regardless of input order', () => {
    const result = prepared({
      availableTools: [tool('gamma_z'), tool('alpha_a'), tool('beta_m')],
    });
    expect(namesOf(result.tools)).toEqual(['alpha_a', 'beta_m', 'gamma_z']);
  });

  it('produces identical serialization for two different input orders', () => {
    const inOrderA = [tool('srvB_read'), tool('srvA_write'), tool('srvA_read')];
    const inOrderB = [tool('srvA_read'), tool('srvB_read'), tool('srvA_write')];

    const a = prepared({ availableTools: inOrderA });
    const b = prepared({ availableTools: inOrderB });

    // Byte-identical block -> keeps hitting the provider prefix cache.
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
    expect(namesOf(a.tools)).toEqual(['srvA_read', 'srvA_write', 'srvB_read']);
  });

  it('does not mutate the caller-supplied tool array', () => {
    const input = [tool('z_tool'), tool('a_tool')];
    ToolHandler.prepareTools({ availableTools: input });
    // Original array order preserved (sort operates on a copy).
    expect(input.map(t => t.name)).toEqual(['z_tool', 'a_tool']);
  });

  it('uses a locale-independent (code-unit) comparison', () => {
    // Uppercase sorts before lowercase under code-unit ordering; a locale-aware
    // sort could disagree. Lock in the deterministic code-unit result.
    const result = prepared({
      availableTools: [tool('apple'), tool('Banana'), tool('Apple')],
    });
    expect(namesOf(result.tools)).toEqual(['Apple', 'Banana', 'apple']);
  });
});
