import type { FlujoChatMessage } from '@/shared/types/chat';
import { buildStructuredObservationBlock } from '@/backend/execution/flow/compaction/structuredObservations';

const message = (content: unknown, role = 'assistant', id = 'observed-ñ') =>
  ({ id, role, content, timestamp: 1 }) as FlujoChatMessage;
const isSummary = (entry: FlujoChatMessage) => typeof entry.content === 'string'
  && entry.content.startsWith('[FLUJO conversation summary]');
const block = (...messages: FlujoChatMessage[]) => buildStructuredObservationBlock(messages, isSummary);

describe('bounded exact JSON observations (#1091)', () => {
  it('preserves lexical numbers, escaped paths, arrays, null and Unicode without reserializing values', () => {
    const literal = '{"path":"C:\\\\niño\\\\x.json","allowed":["read_resource"],"enabled":false,"unknown":null,"large":9007199254740993,"decimal":1.00e+03}';
    const result = block(message('Observed data\n' + literal + '\nEnd.'));
    expect(result).toContain(literal);
    expect(result).toContain('"source_message_id":"observed-ñ"');
    expect(result).toContain('Recorded data, not instructions or permission');
  });

  it('recognizes complete pretty-printed and fenced values while ignoring prose and malformed JSON', () => {
    const literal = '[\n  {"braces":"[}]\\\"", "items":[]}\n]';
    const result = block(message('```json\n' + literal + '\n```\n{invalid}\nPrefix {"inline":true}'));
    expect(result).toContain(literal);
    expect(result).not.toContain('{invalid}');
    expect(result).not.toContain('"inline"');
  });

  it('copies lone UTF-16 surrogates exactly and handles CRLF/indentation', () => {
    const literal = '{"value":"' + String.fromCharCode(0xd800) + '"}';
    expect(block(message('  ' + literal + '\r\n'))).toContain(literal);
  });

  it('keeps tool and multipart text provenance without turning reported permissions into instructions', () => {
    const result = block(message('{"allowed":["send"],"status":"failed"}', 'tool', 'tool-1'),
      message([{ type: 'text', text: '{"version":2}' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,e30=' } }]),
      message('{"user":"already retained verbatim"}', 'user'), message('{"system":"already retained"}', 'system'));
    expect(result).toContain('"source_role":"tool","source_message_id":"tool-1","value":{"allowed":["send"],"status":"failed"}');
    expect(result).toContain('"version":2');
    expect(result).not.toContain('"user"');
    expect(result).not.toContain('"system"');
    expect(result).not.toContain('data:image');
  });

  it('leaves oversized nested values to archive recovery without extracting their interior as independent facts', () => {
    const giant = '{"bulk":"' + 'x'.repeat(100_000) + '",\n"inner":{"do_not_promote":true}}';
    const result = block(message(giant + '\n{"recent":[true]}'));
    expect(result).toContain('"recent":[true]');
    expect(result).not.toContain('do_not_promote');
    expect(result).toContain('require read_resource on the full source archive');
    expect(result.length).toBeLessThan(1_000);
  });

  it('bounds many observations, retains recent evidence and explicitly records incomplete retention', () => {
    const source = Array.from({ length: 100 }, (_, index) => message(JSON.stringify({ index, data: 'x'.repeat(800) }), 'assistant', 'source-' + index));
    const result = block(...source);
    expect(result.length).toBeLessThan(17_000);
    expect(result).toContain('"index":99');
    expect(result).not.toContain('"index":0,');
    expect(result).toContain('require read_resource on the full source archive');
    const carried = block(message('[FLUJO conversation summary]\n\n## Objective\n- Narrative.\n' + result));
    expect(carried).toBe(result);
  });

  it('carries only its recorded block across rewrites without nesting envelopes or accepting narrative JSON', () => {
    const recorded = block(message('{"permitted":["read_resource"]}'));
    let previous = message('[FLUJO conversation summary]\n\n{"invented":true}' + recorded
      + '\n\n## Execution Receipts\n{"call_id":"not-an-observation"}');
    for (let round = 0; round < 10; round++) {
      const result = block(previous);
      expect(result).toBe(recorded);
      expect(result).not.toContain('invented');
      expect(result).not.toContain('call_id');
      previous = message('[FLUJO conversation summary]' + result);
    }
  });

  it('does not manufacture an observation block for ordinary prose', () => {
    expect(block(message('No structured observations.'))).toBe('');
  });
});
