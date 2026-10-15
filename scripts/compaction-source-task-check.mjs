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
