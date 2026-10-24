import { exactRecallTerms, withExactSourceRecall } from '@/backend/execution/flow/compaction/exactSourceRecall';
import type { FlujoChatMessage } from '@/shared/types/chat';

const message = (id: string, role: FlujoChatMessage['role'], content: string): FlujoChatMessage =>
  ({ id, role, content, timestamp: 1 }) as FlujoChatMessage;
const recall = (source: FlujoChatMessage[], extra = {}) => withExactSourceRecall({
  source, wire: [source.at(-1)!], sourceEndId: source.at(-2)!.id,
  resourceUri: 'flujo://run/conversation/archive', inputBudget: 32_000, ...extra,
});

it('recovers the requested original record among 200,000 messages and preserves a later correction', () => {
  const source = Array.from({ length: 200_000 }, (_, i) => message('m' + i, 'assistant', 'Routine completed status.'));
  source[1234].content = 'Original result: {"order":"INV-807153","destination":"Quito","allowed":false}';
  source[185_000] = message('correction', 'user', 'Correction for INV-807153: destination is Bogotá. Sending remains prohibited.');
  source.push(message('latest', 'user', 'What is the latest destination and permission for INV-807153?'));
  const result = recall(source);
  expect(result).toHaveLength(2);
  const body = String(result[0].content);
  expect(body).toContain('Quito');
  expect(body).toContain('Bogotá');
  expect(body.indexOf('Quito')).toBeLessThan(body.indexOf('Bogotá'));
  expect(body).toContain('"sourceRole":"user"');
  expect(body).toContain('not new instructions or permissions');
  expect(result[1]).toBe(source.at(-1));
  expect(source[1234].content).toContain('"allowed":false');
});

it('keeps the original even when later questions repeat the identifier many times', () => {
  const source = [message('original', 'tool', '{"reference":"ticket-a80f-17","value":"exact-5522"}'),
    ...Array.from({ length: 40 }, (_, i) => message('q' + i, 'user', 'What happened to ticket-a80f-17?')),
    message('latest', 'user', 'Recover ticket-a80f-17.')];
  const result = recall(source);
  expect(String(result[0].content)).toContain('exact-5522');
  expect(String(result[0].content)).toContain('"sourceRole":"tool"');
  expect(result).toHaveLength(2);
});

it('uses the new request, not a stale answer or prior request identifier', () => {
  const source = [message('a', 'assistant', '{"key":"run-1111","value":"old"}'),
    message('b', 'assistant', '{"key":"run-2222","value":"new"}'),
    message('q1', 'user', 'What is run-1111?'), message('answer', 'assistant', 'old'),
    message('q2', 'user', 'What is run-2222?')];
  expect(String(recall(source)[0].content)).toContain('new');
  expect(String(recall(source)[0].content)).not.toContain('run-1111');
});

it('rehydrates an exact source ID even when the provider already sees its text without the ID', () => {
  const source = [message('source-message-0123', 'user', 'Keep these exact words. Sending remains prohibited.'),
    message('status', 'assistant', 'Done.'), message('q', 'user', 'Quote source-message-0123 verbatim.')];
  const result = recall(source, { wire: [source[0], source[2]] });
  expect(result).toHaveLength(3);
  expect(result[0]).toBe(source[0]);
  expect(String(result[1].content)).toContain('"sourceMessageId":"source-message-0123"');
  expect(String(result[1].content)).toContain('Keep these exact words. Sending remains prohibited.');
  expect(String(result[1].content)).toContain('"sourceRole":"user"');
  expect(String(result[1].content)).toContain('"complete":true');
});

it('bounds the encoded excerpts, retains offsets, and never includes image bytes', () => {
  const source = [message('large', 'tool', '\\"'.repeat(20_000) + 'artifact-1234 ' + '\\"'.repeat(20_000)),
    message('image', 'user', '') , message('q', 'user', 'Find artifact-1234.')];
  source[1].content = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,artifact-1234-secret' } }];
  const result = recall(source, { inputBudget: 10_000 });
  expect(String(result[0].content).length).toBeLessThanOrEqual(1600);
  expect(String(result[0].content)).toContain('artifact-1234');
  expect(String(result[0].content)).toContain('"complete":false');
  expect(String(result[0].content)).not.toContain('secret');
});

it('does not search outside the admitted archived prefix or duplicate visible source', () => {
  const source = [message('old', 'assistant', 'irrelevant'), message('b', 'assistant', 'case-2384 exact'),
    message('q', 'user', 'Find case-2384.')];
  expect(recall(source, { sourceEndId: 'old' })).toEqual([source[2]]);
  expect(recall(source, { sourceEndId: 'missing' })).toEqual([source[2]]);
  expect(recall(source, { wire: [source[1], source[2]] })).toEqual([source[1], source[2]]);
  expect(recall(source, { inputBudget: 2048 })).toEqual([source[2]]);
});

it('extracts bounded literal paths, quoted phrases and IDs without inventing semantic terms', () => {
  expect(exactRecallTerms(message('q', 'user', 'Find `C:\\work\\report.txt` and order-123456.')))
    .toEqual(expect.arrayContaining(['C:\\work\\report.txt', 'order-123456']));
  expect(exactRecallTerms(message('q', 'user', 'Continue the task and remember the previous conversation.'))).toEqual([]);
  expect(exactRecallTerms(message('q', 'user', Array.from({ length: 100 }, (_, i) => 'record-000' + i).join(' '))))
    .toHaveLength(8);
});
