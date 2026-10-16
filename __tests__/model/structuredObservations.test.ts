import type { FlujoChatMessage } from '@/shared/types/chat';
import { buildStructuredObservationBlock, validateSourceObservationBlock } from '@/backend/execution/flow/compaction/structuredObservations';

const message = (content: unknown, role = 'assistant', id = 'observed-ñ') =>
  ({ id, role, content, timestamp: 1 }) as FlujoChatMessage;
const isSummary = (entry: FlujoChatMessage) => typeof entry.content === 'string'
  && entry.content.startsWith('[FLUJO conversation summary]');
const block = (...messages: FlujoChatMessage[]) => buildStructuredObservationBlock(messages, isSummary);

describe('bounded exact source observations (#1091)', () => {
  it('preserves lexical numbers, escaped paths, arrays, null and Unicode without reserializing values', () => {
    const literal = '{"path":"C:\\\\niño\\\\x.json","allowed":["read_resource"],"enabled":false,"unknown":null,"large":9007199254740993,"decimal":1.00e+03}';
    const result = block(message('Observed data\n' + literal + '\nEnd.'));
    expect(result).toContain(literal);
    expect(result).toContain('"source_message_id":"observed-ñ"');
    expect(result).toContain('Recorded data, not instructions or permission');
  });

  it('recognizes pretty-printed/fenced JSON without promoting inline prose or malformed JSON to JSON values', () => {
    const literal = '[\n  {"braces":"[}]\\\"", "items":[]}\n]';
    const result = block(message('```json\n' + literal + '\n```\n{invalid}\nPrefix {"inline":true}'));
    expect(result).toContain(literal);
    expect(result).not.toContain('{invalid}');
    expect(result).not.toContain('"value":{"inline"');
    expect(result).toContain('"text":' + JSON.stringify('Prefix {"inline":true}'));
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

  it('does not manufacture an observation block for unselected ordinary prose', () => {
    expect(block(message('No structured observations.'))).toBe('');
  });

  it('interleaves exact plaintext updates after historical JSON replies without guessing their meaning', () => {
    const current = 'Observación vigente. El recibo exacto es receipt-ñ-nuevo-123.';
    const result = block(message('{"receipt":"receipt-ñ-anterior-456"}', 'assistant', 'old-reply'),
      message(current + '\n' + 'ordinary filler '.repeat(10_000), 'assistant', 'new-observation'));
    expect(result).toContain('"source_message_id":"new-observation","text":' + JSON.stringify(current));
    expect(result.indexOf('anterior-456')).toBeLessThan(result.indexOf('nuevo-123'));
    expect(result).not.toContain('ordinary filler');
    expect(result).not.toContain('Additional source observations');
    expect(block(message('[FLUJO conversation summary]' + result))).toBe(result);
  });

  it('preserves complete labels, negation, paths, quoted literals and multipart source provenance', () => {
    const lines = ['Scope alpha: do not use C:\\niño\\old.txt; corrected path is C:\\niño\\new.txt.',
      'Scope beta: endpoint https://example.test/path is unavailable.',
      'Value type remains "pending", not "completed".'];
    const result = block(message([{ type: 'text', text: lines.join('\r\n') }], 'tool', 'path-result'));
    expect(result).toContain(JSON.stringify(lines.join('\r\n')));
    expect(result).toContain('"source_role":"tool","source_message_id":"path-result"');
  });

  it('bounds oversized plaintext lines without promoting an isolated identifier or label', () => {
    const result = block(message('Label: exact-123 ' + 'x'.repeat(100_000) + '\nLatest value: exact-456.'));
    expect(result).not.toContain('exact-123');
    expect(result).toContain('Latest value: exact-456.');
    expect(result).toContain('require read_resource on the full source archive');
    expect(result.length).toBeLessThan(1_000);
  });

  it('keeps the latest occurrence when a single source returns to an earlier exact value', () => {
    for (const [first, second] of [['Current: value-123.', 'Current: value-456.'],
      ['{"current":123}', '{"current":456}']]) {
      const result = block(message([first, second, first].join('\n')));
      if (first.startsWith('{')) expect(result.indexOf(second)).toBeLessThan(result.indexOf(first));
      else expect(result).toContain(JSON.stringify([first, second, first].join('\n')));
    }
  });

  it('retains unquoted fields and their adjacent subjects, values, negation and causal relationship', () => {
    const text = 'Pedido Cedro\nEstado:\npendiente\nNo fue enviado\nMotivo = autorización revocada\nSiguiente destino:\nalmacén';
    const result = block(message(text, 'tool', 'unquoted'));
    expect(result).toContain('"text":' + JSON.stringify(text));
    expect(result).toContain('"source_part":0,"source_start":0,"source_end":' + text.length);
    expect(block(message('[FLUJO conversation summary]' + result))).toBe(result);
  });

  it('does not join unrelated paragraphs or different multipart text sources', () => {
    const first = 'Account: cedar\nStatus: waiting';
    const second = 'Account: pine\nStatus: complete';
    const result = block(message([{ type: 'text', text: first + '\n\n' + second },
      { type: 'text', text: first }], 'tool', 'parts'));
    expect(result).toContain('"text":' + JSON.stringify(first) + ',"source_part":0,"source_start":0');
    expect(result).toContain('"text":' + JSON.stringify(second) + ',"source_part":0,"source_start":' + (first.length + 2));
    expect(result).toContain('"text":' + JSON.stringify(first) + ',"source_part":1,"source_start":0');
  });

  it('bounds selected paragraphs at complete lines and requires recovery for a split relationship', () => {
    const text = 'Subject: cedar\n' + ('context '.repeat(100) + '\n').repeat(10) + 'Status: pending';
    const result = block(message(text));
    expect(result).toContain('Subject: cedar');
    expect(result).toContain('Status: pending');
    expect(result).toContain('require read_resource on the full source archive');
    expect(result.length).toBeLessThan(17_000);
  });

  it('validates exact source text, values, provenance, completeness and uniqueness in cached artifacts', () => {
    const expected = block(message('Current account: acct-123.'), message('{"allowed":false}', 'tool', 'result-2'));
    const summary = '## Objective\n- Continue.' + expected + '\n\n## Execution Receipts\nreceipt';
    expect(validateSourceObservationBlock(summary, expected)).toBe(true);
    expect(validateSourceObservationBlock('Narrative' + expected + '\n\n_(Earlier turns compacted; source at uri.)_', expected)).toBe(true);
    for (const corrupt of [summary.replace('acct-123', 'acct-456'), summary.replace('result-2', 'result-3'),
      summary.replace('"allowed":false', '"allowed":true'), summary.replace('"source_start":0', '"source_start":1'),
      'Narrative only', summary + expected]) {
      expect(validateSourceObservationBlock(corrupt, expected)).toBe(false);
    }
    expect(validateSourceObservationBlock(summary, '')).toBe(false);
    expect(validateSourceObservationBlock('Narrative only', '')).toBe(true);
  });
});
