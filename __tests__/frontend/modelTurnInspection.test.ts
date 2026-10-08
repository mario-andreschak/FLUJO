import { createHash } from 'node:crypto';
import { readModelTurnInspection } from '@/frontend/services/chat/modelTurnInspection';

function response(value: unknown, size = 17, wrongHash = false, raw = false) {
  const bytes = Buffer.from(raw ? String(value) : JSON.stringify(value));
  let wire = '';
  for (let offset = 0; offset < bytes.length; offset += 65536) wire += JSON.stringify({ kind: 'chunk', data: bytes.subarray(offset, offset + 65536).toString('base64') }) + '\n';
  wire += JSON.stringify({ kind: 'end', bytes: bytes.length, sha256: wrongHash ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex') }) + '\n';
  const encoded = Buffer.from(wire);
  return new Response(new ReadableStream({
    start(controller) { for (let offset = 0; offset < encoded.length; offset += size) controller.enqueue(encoded.subarray(offset, offset + size)); controller.close(); },
  }), { headers: { 'X-Flujo-Model-Turn-Format': 'json-chunks-v1' } });
}
const snapshot = (sdkRequest: unknown) => ({ version: 2, entry: { id: 'dispatch', conversationId: 'conversation', outcome: 'running' }, canonicalMessages: [], genericWire: [], media: [], sdkRequest });
function pages(value: NonNullable<Awaited<ReturnType<typeof readModelTurnInspection>>['sdkRequest']>) {
  let text = '';
  for (let index = 0; ; index++) { const page = value.readPage(index); expect(page.text.length).toBeLessThanOrEqual(65536); text += page.text; if (!page.hasNext) return text; }
}
it('preserves complete escaped Unicode values across transport and view boundaries', async () => {
  const input = ('🌍"\\\nĀ'.repeat(15000));
  const view = await readModelTurnInspection(response(snapshot({ input, options: { signal: '[AbortSignal]' } })));
  expect(pages(view.sdkRequest!.child('input')!)).toBe(input);
  expect(JSON.parse(pages(view.sdkRequest!.child('options')!))).toEqual({ signal: '[AbortSignal]' });
});
it('keeps dense and wide SDK values as byte-backed views with full round-trip integrity', async () => {
  const request = { values: Array.from({ length: 20000 }, (_, index) => ({ key: index })) };
  const view = await readModelTurnInspection(response(snapshot(request), 65536));
  expect(JSON.parse(pages(view.sdkRequest!))).toEqual(request);
  expect(view.kind).toBe('chunked-model-turn');
});
it('uses final duplicate field values without materializing preceding SDK objects', async () => {
  const value = JSON.stringify(snapshot({ input: 'first' })).replace('"input":"first"', '"input":{"discarded":true},"input":"last"');
  const view = await readModelTurnInspection(response(value, 17, false, true));
  expect(pages(view.sdkRequest!.child('input')!)).toBe('last');
  expect(view.sdkRequest!.child('absent')).toBeUndefined();
});
it('retains oversized metadata in complete Original JSON with an explicit flag', async () => {
  const value = { ...snapshot({ input: 'complete' }), provenance: { source: 'x'.repeat(70000) } };
  const view = await readModelTurnInspection(response(value, 65536));
  expect(view.additionalMetadata).toBe(true);
  expect(JSON.parse(pages(view.source))).toEqual(value);
});
it('rejects a corrupt digest rather than returning a partial view', async () => {
  await expect(readModelTurnInspection(response(snapshot({ complete: true }), 17, true))).rejects.toThrow('integrity');
});
it('preserves the original abort reason and cancels a pending transport reader', async () => {
  const controller = new AbortController(); let cancelled = false;
  const pending = readModelTurnInspection(new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'X-Flujo-Model-Turn-Format': 'json-chunks-v1' },
  }), controller.signal);
  const reason = new Error('client left'); controller.abort(reason);
  await expect(pending).rejects.toBe(reason); expect(cancelled).toBe(true);
});
