// This controlled receipt fixture never asks the agent to summarize its
// conversation. Detect positive claims that our control became that task,
// while allowing an explicit statement that no source request was made.
export function hasCompactionTaskLeak(text) {
  const claims = text.replace(/\bno (?:new )?user request beyond (?:the )?compaction control\b/gi,
    'no source request');
  return /(?:user|usuario).{0,60}(?:request|asked|solicit|pidi).{0,60}(?:summar|resum|compact)/i.test(claims)
    || /(?:emit|output|produc|provid|prepar|writ|generat).{0,60}(?:summary|sections|resumen|secciones)/i.test(claims)
    || /(?:summari[sz](?:e|ing)|resumir|resumiendo|compactar|compactando).{0,60}(?:conversation|conversaci[oó]n)/i.test(claims);
}
import assert from 'node:assert/strict';

export function parseProviderResponse(raw) {
  try { return JSON.parse(raw); } catch { /* Responses may arrive as SSE. */ }
  const events = raw.split(/\r?\n/).filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => { try { return JSON.parse(line.slice(6)); } catch { return null; } }).filter(Boolean);
  const statuses = { 'response.completed': 'completed', 'response.failed': 'failed', 'response.incomplete': 'incomplete' };
  const terminal = events.findLast(event => statuses[event.type] && event.response);
  return { ...(terminal ? { ...terminal.response, status: terminal.response.status ?? statuses[terminal.type] } : {
    id: events.find(event => event.response?.id)?.response?.id,
    model: events.find(event => event.response?.model)?.response?.model,
    status: 'unresolved', usage: events.findLast(event => event.response?.usage)?.response?.usage,
    content: events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta ?? '').join(''),
  }), sseEvents: events.length, eventTypes: [...new Set(events.map(event => event.type))] };
}

/** A provider can return HTTP 200 with a failed Responses envelope, then the
 * actual adapter retries. Require one completed result, without mistaking that
 * recovery for a second successful summary or hiding duplicate completions. */
export function assertSingleCompletedProviderCall(calls, kind) {
  const attempts = calls.filter(call => call.kind === kind);
  const completed = attempts.filter(call => call.status === 200
    && call.response?.status === 'completed' && !call.response.error);
  assert.equal(completed.length, 1, 'Expected exactly one completed ' + kind + ' response');
  assert.equal(attempts.at(-1), completed[0], 'The final attempt must be the completed response');
  for (const attempt of attempts) {
    if (attempt === completed[0]) continue;
    const response = attempt.response;
    const failedEnvelope = response?.status === 'failed'
      || (response?.error && !['completed', 'incomplete'].includes(response.status))
      // Older frozen traces recorded the failed event type but discarded its
      // terminal envelope. Keep that explicit failure evidence usable.
      || (response?.eventTypes?.includes('response.failed') && !response.eventTypes.includes('response.completed'));
    assert(attempt.status === undefined || attempt.status >= 500 || failedEnvelope,
      'Only failed transport/provider attempts may precede a completed response');
  }
  return completed[0];
}


export function assertCompleteCanonicalFallback({ wire, canonicalBeforeReply, currentObservation, instruction,
  previousArtifact, artifact }) {
  assert(previousArtifact, 'The first round must establish a durable summary');
  assert.deepEqual(artifact, previousArtifact, 'A refused summary must preserve the complete previous artifact');
  assert(!wire.some(message => message.content.includes('[FLUJO conversation summary]')),
    'A fallback must not send a stale or partly accepted summary');
  assert(wire.some(message => message.role === 'user' && message.content === instruction));
  assert(wire.some(message => message.role === 'assistant' && message.content === currentObservation));
  let cursor = 0;
  for (const original of canonicalBeforeReply) {
    const index = wire.findIndex((message, position) => position >= cursor
      && message.role === original.role && message.content === original.content);
    assert(index >= cursor, 'Canonical fallback omitted or changed a source message: ' + original.id);
    cursor = index + 1;
  }
}
