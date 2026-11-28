import type { FlujoChatMessage } from '@/shared/types/chat';
import { nativeCompactionCarry, NATIVE_COMPACTION_CARRY_HEADING } from '@/backend/execution/flow/compaction/nativeCompactionCarry';

let seq = 0;
const msg = (partial: Record<string, unknown>) => ({ id: `m${seq++}`, timestamp: 1, ...partial } as unknown as FlujoChatMessage);
const user = (content: string, extra: Record<string, unknown> = {}) => msg({ role: 'user', content, ...extra });
const call = (id: string, name: string, args: string) => msg({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] });
const result = (id: string) => msg({ role: 'tool', tool_call_id: id, content: 'done' });

it('keeps every standing instruction word for word and the exact receipts, and nothing else', () => {
  const carry = nativeCompactionCarry([
    user('Please summarise the report.'),
    user('Never delete files in /data.'),
    call('call-1', 'files__write', '{"path":"a.txt"}'), result('call-1'),
    call('call-2', 'mail__send', '{"to":"team"}'),
    user('Actually, use the March numbers instead.'),
    user('Steered in later', { injected: true }),
  ])!;
  expect(carry.complete).toBe(true);
  expect(carry.text.startsWith(NATIVE_COMPACTION_CARRY_HEADING)).toBe(true);
  expect(carry.text).toContain('1. Never delete files in /data.\n2. Actually, use the March numbers instead.\n3. Steered in later');
  expect(carry.text).not.toContain('Please summarise the report.');
  expect(carry.text).toContain('{"call_id":"call-1","tool":"files__write","state":"result-observed","arguments":"{\\"path\\":\\"a.txt\\"}"}');
  expect(carry.text).toContain('{"call_id":"call-2","tool":"mail__send","state":"unresolved"');
});

it('has nothing to carry for plain requests without tool calls', () => {
  expect(nativeCompactionCarry([user('Write a haiku.'), msg({ role: 'assistant', content: 'Here it is.' })])).toBeUndefined();
});

it('marks the carry incomplete when instructions or receipts do not fit, so the thread is rebuilt', () => {
  const longInstruction = user(`Never touch ${'x'.repeat(70_000)}`);
  const tooLong = nativeCompactionCarry([longInstruction, user('Always reply in German.')])!;
  expect(tooLong.complete).toBe(false);
  expect(tooLong.text).toContain('1. Always reply in German.');
  expect(tooLong.text.length).toBeLessThanOrEqual(64_000);

  const calls = Array.from({ length: 400 }, (_, index) => call(`call-${index}`, 'files__write', `{"path":"${'p'.repeat(60)}${index}"}`));
  const manyReceipts = nativeCompactionCarry(calls)!;
  expect(manyReceipts.complete).toBe(false);
  expect(manyReceipts.text).toContain('earlier receipts are in the full source archive');
  expect(manyReceipts.text).toContain('"call_id":"call-399"');
});
