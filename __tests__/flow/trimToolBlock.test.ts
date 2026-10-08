/**
 * Tests for trimToolBlock — shrinking the serialized tool block.
 *
 * The block is the largest fixed cost of a tool-using step and stateless Chat
 * Completions re-sends it every turn, so bytes removed here are saved once per
 * turn of the agentic loop.
 *
 * Pins:
 *  - Tier A (lossless, always on): bookkeeping keywords, output-only annotations,
 *    redundant titles, and template-literal indentation are removed
 *  - Tier A NEVER removes a keyword that changes what a valid argument is
 *  - Tier B (opt-in): descriptions capped at a sentence boundary
 *  - the result is deterministic (byte-stable) and order-preserving, so the
 *    provider prefix cache keeps hitting (#89)
 */

import type OpenAI from 'openai';
import {
  trimTools,
  tidyDescription,
  truncateAtBoundary,
} from '@/backend/execution/flow/handlers/trimToolBlock';

/** The `properties` map of a trimmed tool's parameter schema. */
const propsOf = (tool: OpenAI.ChatCompletionFunctionTool): Record<string, Record<string, unknown>> =>
  (tool as unknown as { function: { parameters: { properties: Record<string, Record<string, unknown>> } } })
    .function.parameters.properties;

const toolWith = (
  parameters: Record<string, unknown>,
  description = 'Does a thing.',
): OpenAI.ChatCompletionFunctionTool => ({
  type: 'function',
  function: { name: 'do_thing', description, parameters },
});

describe('tidyDescription', () => {
  it('strips the indentation a template literal drags in', () => {
    const raw = 'Search for files.\n\n      Supports globs.\n      Case-insensitive.';
    expect(tidyDescription(raw)).toBe('Search for files.\n\nSupports globs.\nCase-insensitive.');
  });

  it('preserves relative indentation (markdown lists, fenced code)', () => {
    const raw = 'Options:\n    - a\n      - nested\n    - b';
    expect(tidyDescription(raw)).toBe('Options:\n- a\n  - nested\n- b');
  });

  it('collapses runs of blank lines and trims the ends', () => {
    expect(tidyDescription('  a\n\n\n\nb  \n\n')).toBe('a\n\nb');
  });

  it('leaves an already-tidy single line untouched', () => {
    expect(tidyDescription('Read a file.')).toBe('Read a file.');
  });
});

describe('truncateAtBoundary', () => {
  it('returns the text unchanged when it fits', () => {
    expect(truncateAtBoundary('short', 100)).toBe('short');
  });

  it('cuts at a sentence boundary and marks the truncation', () => {
    const text = 'First sentence. Second sentence. Third sentence that runs on and on.';
    const out = truncateAtBoundary(text, 40);
    expect(out).toBe('First sentence. Second sentence. […]');
  });

  it('falls back to a word boundary when no sentence break is usable', () => {
    const out = truncateAtBoundary('averylongstream of words with no sentence breaks at all here', 30);
    expect(out.endsWith('[…]')).toBe(true);
    // Never a mid-word fragment.
    expect(out.replace(' […]', '').endsWith('word')).toBe(false);
    expect(out.length).toBeLessThanOrEqual(35);
  });

  it('is a no-op when the cap is 0 (capping disabled)', () => {
    const text = 'a'.repeat(500);
    expect(truncateAtBoundary(text, 0)).toBe(text);
  });
});

describe('Tier A — lossless pruning', () => {
  it('drops schema bookkeeping and output-only annotations', () => {
    const { tools } = trimTools([
      toolWith({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: 'urn:tool:do_thing',
        $comment: 'internal note',
        type: 'object',
        properties: {
          path: { type: 'string', readOnly: false, deprecated: false, $comment: 'x' },
        },
      }),
    ]);

    const params = (tools[0] as { function: { parameters: Record<string, unknown> } }).function.parameters;
    expect(params).not.toHaveProperty('$schema');
    expect(params).not.toHaveProperty('$id');
    expect(params).not.toHaveProperty('$comment');
    const path = (params.properties as Record<string, Record<string, unknown>>).path;
    expect(path).not.toHaveProperty('readOnly');
    expect(path).not.toHaveProperty('deprecated');
    expect(path).not.toHaveProperty('$comment');
    // The part that matters is still there.
    expect(path.type).toBe('string');
  });

  it('drops a title that merely restates the property name', () => {
    const { tools } = trimTools([
      toolWith({
        type: 'object',
        properties: {
          max_results: { type: 'number', title: 'Max Results' },
          path: { type: 'string', title: 'Absolute path on disk' },
        },
      }),
    ]);

    const props = propsOf(tools[0]);
    expect(props.max_results).not.toHaveProperty('title');
    // A title that actually says something is kept.
    expect(props.path.title).toBe('Absolute path on disk');
  });

  it('NEVER removes a keyword that changes what a valid argument is', () => {
    const params = {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['a', 'b'], default: 'a' },
        count: { type: 'number', minimum: 1, maximum: 10 },
        name: { type: 'string', pattern: '^[a-z]+$' },
        tag: { const: 'fixed' },
      },
      required: ['mode'],
      additionalProperties: false,
    };
    const { tools } = trimTools([toolWith(params)]);
    const out = (tools[0] as { function: { parameters: Record<string, unknown> } }).function.parameters;

    // Byte-identical: there was nothing droppable in this schema.
    expect(JSON.stringify(out)).toBe(JSON.stringify(params));
  });

  it('keeps examples when capping is off', () => {
    const { tools } = trimTools([
      toolWith({ type: 'object', properties: { q: { type: 'string', examples: ['foo'] } } }),
    ]);
    expect(propsOf(tools[0]).q.examples).toEqual(['foo']);
  });

  it('recurses through items, $defs and the composition keywords', () => {
    const { tools } = trimTools([
      toolWith({
        type: 'object',
        properties: {
          list: { type: 'array', items: { type: 'object', $comment: 'drop me', properties: {} } },
          either: { anyOf: [{ type: 'string', $id: 'a' }, { type: 'number' }] },
        },
        $defs: { Thing: { type: 'object', $schema: 'x' } },
      }),
    ]);

    const serialized = JSON.stringify(tools[0]);
    expect(serialized).not.toContain('$comment');
    expect(serialized).not.toContain('$id');
    expect(serialized).not.toContain('$schema');
    // Structure survives.
    expect(serialized).toContain('anyOf');
    expect(serialized).toContain('$defs');
  });

  it('leaves non-function tools alone', () => {
    const custom = { type: 'custom', custom: { name: 'x' } } as unknown as OpenAI.ChatCompletionFunctionTool;
    const { tools } = trimTools([custom]);
    expect(tools[0]).toBe(custom);
  });
});

describe('Tier B — opt-in description capping', () => {
  const longDescription =
    'Reads a file from disk. ' +
    'Accepts an absolute or relative path. ' +
    'Relative paths resolve against the node root. ' +
    'Binary files are returned base64-encoded. ' +
    'Symlinks are followed unless they escape the configured root.';

  it('does nothing without a cap', () => {
    const { tools } = trimTools([toolWith({ type: 'object' }, longDescription)]);
    expect((tools[0] as { function: { description: string } }).function.description).toBe(longDescription);
  });

  it('caps the tool description at a sentence boundary when asked', () => {
    const { tools } = trimTools([toolWith({ type: 'object' }, longDescription)], {
      descriptionMaxChars: 60,
    });
    const out = (tools[0] as { function: { description: string } }).function.description;
    expect(out.length).toBeLessThan(longDescription.length);
    expect(out.endsWith('[…]')).toBe(true);
    // The most important sentence — what the tool does — survives.
    expect(out).toContain('Reads a file from disk.');
  });

  it('gives property descriptions a quarter of the budget by default', () => {
    const { tools } = trimTools(
      [
        toolWith({
          type: 'object',
          properties: { path: { type: 'string', description: longDescription } },
        }),
      ],
      { descriptionMaxChars: 400 },
    );
    const props = propsOf(tools[0]);
    expect((props.path.description as string).length).toBeLessThan(longDescription.length);
  });

  it('drops examples once the opt-in tier is active', () => {
    const { tools } = trimTools(
      [toolWith({ type: 'object', properties: { q: { type: 'string', examples: ['foo'] } } })],
      { descriptionMaxChars: 200 },
    );
    expect(propsOf(tools[0]).q).not.toHaveProperty('examples');
  });

  it('reports the size before and after so the saving is measurable', () => {
    const { beforeChars, afterChars } = trimTools([toolWith({ type: 'object' }, longDescription)], {
      descriptionMaxChars: 60,
    });
    expect(beforeChars).toBeGreaterThan(afterChars);
  });
});

describe('prefix-cache invariants', () => {
  const tools: OpenAI.ChatCompletionFunctionTool[] = [
    toolWith({ type: 'object', $schema: 'x', properties: { a: { type: 'string', title: 'A' } } }),
    { type: 'function', function: { name: 'other', description: 'B.', parameters: { type: 'object' } } },
  ];

  it('is deterministic — the same input trims to the same bytes', () => {
    const a = trimTools(tools, { descriptionMaxChars: 50 });
    const b = trimTools(tools, { descriptionMaxChars: 50 });
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
  });

  it('preserves tool order (ToolHandler already sorted it)', () => {
    const { tools: out } = trimTools(tools);
    expect(out.map((t) => (t as { function: { name: string } }).function.name)).toEqual(['do_thing', 'other']);
  });

  it('does not mutate the input', () => {
    const snapshot = JSON.stringify(tools);
    trimTools(tools, { descriptionMaxChars: 20 });
    expect(JSON.stringify(tools)).toBe(snapshot);
  });

  it('handles an empty or absent tool list', () => {
    expect(trimTools([]).tools).toEqual([]);
    expect(trimTools(undefined).tools).toEqual([]);
  });
});
