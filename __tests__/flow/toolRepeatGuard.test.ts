import {
  applyToolRepeatGuard,
  canonicalToolArguments,
  classifyToolExitCode,
  type ToolRepeatGuardState,
} from '@/backend/execution/flow/toolRepeatGuard';
import type { ToolCallInfo } from '@/backend/execution/flow/types';

const state = (): ToolRepeatGuardState => ({ logicalRunId: 'run-1', entries: [] });
const call = (overrides: Partial<ToolCallInfo> = {}): ToolCallInfo => ({
  name: 'list_dir',
  args: { path: '.' },
  id: crypto.randomUUID(),
  result: '{"files":[]}',
  exitCode: 0,
  ...overrides,
});

describe('toolRepeatGuard', () => {
  it('raises temperature on the third successful repeat and hints on the fifth', () => {
    const guard = state();
    expect(applyToolRepeatGuard(guard, [call()])).toEqual({ raiseTemperature: false, hints: [] });
    expect(applyToolRepeatGuard(guard, [call()])).toEqual({ raiseTemperature: false, hints: [] });
    expect(applyToolRepeatGuard(guard, [call()])).toEqual({ raiseTemperature: true, hints: [] });
    expect(applyToolRepeatGuard(guard, [call()])).toEqual({ raiseTemperature: false, hints: [] });
    expect(applyToolRepeatGuard(guard, [call()])).toEqual({
      raiseTemperature: false,
      hints: ['System-Hint: You repeated the same tool call 5 times with the same result. Try something else.'],
    });
    expect(applyToolRepeatGuard(guard, [call()])).toEqual({ raiseTemperature: false, hints: [] });
  });

  it('raises temperature on the second failed repeat and hints on the third', () => {
    const guard = state();
    const failed = () => call({ result: '{"error":"outside roots"}', exitCode: 1 });
    expect(applyToolRepeatGuard(guard, [failed()])).toEqual({ raiseTemperature: false, hints: [] });
    expect(applyToolRepeatGuard(guard, [failed()])).toEqual({ raiseTemperature: true, hints: [] });
    expect(applyToolRepeatGuard(guard, [failed()])).toEqual({
      raiseTemperature: false,
      hints: ['System-Hint: You repeated the same tool call 3 times with the same result. Try something else.'],
    });
  });

  it('matches parameter objects regardless of key order but keeps different results separate', () => {
    expect(canonicalToolArguments({ z: 1, nested: { b: 2, a: 1 } }))
      .toBe(canonicalToolArguments({ nested: { a: 1, b: 2 }, z: 1 }));
    const guard = state();
    applyToolRepeatGuard(guard, [call({ args: { b: 2, a: 1 } })]);
    applyToolRepeatGuard(guard, [call({ args: { a: 1, b: 2 } })]);
    expect(applyToolRepeatGuard(guard, [call({ args: { a: 1, b: 2 }, result: 'different' })]))
      .toEqual({ raiseTemperature: false, hints: [] });
    expect(guard.entries).toHaveLength(2);
  });

  it('classifies transport errors and MCP protocol isError results as exit code 1', () => {
    expect(classifyToolExitCode('Error: failed')).toBe(1);
    expect(classifyToolExitCode('{"content":[],"isError":true}')).toBe(1);
    expect(classifyToolExitCode('{"content":[]}')).toBe(0);
  });
});
