import type { ModelStreamDelta } from './types';

/**
 * Progressive (paced) tool-argument streaming — issue #337.
 *
 * Some runtimes (the Codex SDK today) only hand FLUJO a tool call once its
 * arguments are fully assembled. The chat UI, however, renders `toolCallDelta`
 * fragments live, so those adapters would show a tool card that jumps from
 * "nothing" to a complete multi-kilobyte payload.
 *
 * This helper replays an ALREADY KNOWN argument string as a name-first,
 * chunked delta sequence so the same UI path is exercised. The pacing is
 * therefore SYNTHETIC and is deliberately:
 *
 *  - **lossless** — the concatenation of every emitted `argumentsDelta` is
 *    byte-for-byte the original string, so the frontend's accumulator ends up
 *    with the exact arguments used for approval and execution;
 *  - **safe to render** — chunks never split a UTF-16 surrogate pair, so a
 *    partially-received string can always be displayed (the frontend's
 *    `formatPartialJson` closes the remaining JSON structure);
 *  - **bounded** — at most {@link MAX_TOOL_ARGUMENT_CHUNKS} chunks and hence a
 *    bounded added latency before the tool actually runs;
 *  - **non-fatal** — a throwing delta consumer can never break tool dispatch.
 */

/** Characters per synthetic argument chunk before the cap kicks in. */
export const DEFAULT_TOOL_ARGUMENT_CHUNK_CHARS = 192;

/** Upper bound on chunks, so a huge payload cannot flood the event bus. */
export const MAX_TOOL_ARGUMENT_CHUNKS = 24;

/** Default gap between chunks; total added latency stays under ~200 ms. */
export const DEFAULT_TOOL_ARGUMENT_DELAY_MS = 8;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/**
 * Split an argument string into display-safe chunks.
 *
 * Returns `[]` for an empty string. A chunk boundary is never placed between
 * the two halves of a surrogate pair, so every prefix of the reassembled
 * stream is valid, renderable text.
 */
export function chunkToolArguments(
  argsJson: string,
  chunkChars: number = DEFAULT_TOOL_ARGUMENT_CHUNK_CHARS,
): string[] {
  if (!argsJson) return [];
  const requested = Number.isFinite(chunkChars) && chunkChars > 0
    ? Math.floor(chunkChars)
    : DEFAULT_TOOL_ARGUMENT_CHUNK_CHARS;
  // Keep the chunk COUNT bounded rather than the chunk size: a 1 MB payload
  // becomes 24 larger chunks instead of thousands of tiny events.
  const size = Math.max(requested, Math.ceil(argsJson.length / MAX_TOOL_ARGUMENT_CHUNKS));

  const chunks: string[] = [];
  let offset = 0;
  while (offset < argsJson.length) {
    let end = Math.min(offset + size, argsJson.length);
    if (end < argsJson.length && isHighSurrogate(argsJson.charCodeAt(end - 1))) end += 1;
    chunks.push(argsJson.slice(offset, end));
    offset = end;
  }
  return chunks;
}

export interface PaceToolCallArgumentsOptions {
  /** Stable streamed message id; reuse it for the durable message so the draft reconciles. */
  messageId: string;
  /** Tool call id carried on the first delta. */
  callId: string;
  /** Tool name, emitted before any argument fragment. */
  name: string;
  /** The fully assembled argument JSON string. */
  argsJson: string;
  /** Tool-call slot within the streamed message (one call per message id by default). */
  index?: number;
  onModelDelta?: (delta: ModelStreamDelta) => void;
  chunkChars?: number;
  /** Set to 0 to emit every chunk without waiting (used by tests). */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise(resolve => { setTimeout(resolve, ms); });

/**
 * Emit a name-first, chunked `toolCallDelta` sequence for an already assembled
 * tool call. Resolves once every fragment has been emitted.
 */
export async function paceToolCallArguments(
  options: PaceToolCallArgumentsOptions,
): Promise<void> {
  const {
    messageId,
    callId,
    name,
    argsJson,
    index = 0,
    onModelDelta,
    chunkChars,
    delayMs = DEFAULT_TOOL_ARGUMENT_DELAY_MS,
    sleep = defaultSleep,
  } = options;
  if (!onModelDelta) return;

  // A consumer fault must never abort the tool call: the durable transcript
  // message is the authoritative record, these deltas are presentation only.
  const emit = (delta: ModelStreamDelta): void => {
    try {
      onModelDelta(delta);
    } catch {
      /* presentation-only stream; keep dispatching the tool call */
    }
  };

  emit({ messageId, toolCallDelta: { index, id: callId, nameDelta: name } });

  const chunks = chunkToolArguments(argsJson, chunkChars);
  for (let i = 0; i < chunks.length; i += 1) {
    emit({ messageId, toolCallDelta: { index, argumentsDelta: chunks[i] } });
    if (delayMs > 0 && i < chunks.length - 1) await sleep(delayMs);
  }
}
