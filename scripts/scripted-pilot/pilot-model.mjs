// The scripted pilot's stand-in for an AI model. It answers like a careful model on the tester
// guide's practice task: find the folders the app may read, read the practice note there, and quote
// its receipt phrase. Everything else (AI Setup's test, other questions) goes to the first-use
// journey's stub. FLUJO still runs its real adapter, tools, approvals and stores.
import { planCompletion } from '../first-journey/stub-model.mjs';
import { randomUUID } from 'node:crypto';

export const PRACTICE_FILE = 'practice-note.txt';
export const PRACTICE_PHRASE = 'pocket-garden-042';
export const PRACTICE_NOTE = `Receipt phrase: ${PRACTICE_PHRASE}\n`;
export const ANSWER_PREFIX = 'The receipt phrase is';
export const COULD_NOT_READ = 'I could not read the practice note';

function text(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  return content == null ? '' : JSON.stringify(content);
}

function call(name, args) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

/** The first folder a get_allowed_directories result names, from its JSON or its plain text. */
export function firstAllowedDirectory(result) {
  const raw = text(result).trim();
  try {
    const parsed = JSON.parse(raw);
    const list = parsed?.directories ?? parsed?.structuredContent?.directories;
    if (Array.isArray(list) && typeof list[0] === 'string') return list[0];
  } catch { /* plain text */ }
  const quoted = /"directories"\s*:\s*\[\s*"((?:[^"\\]|\\.)+)"/.exec(raw);
  if (quoted) return JSON.parse(`"${quoted[1]}"`);
  return raw.split(/\r?\n/).map((line) => line.trim()).find((line) => /^(?:[A-Za-z]:[\\/]|\/)/.test(line));
}

export function joinPath(directory, file) {
  const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
  return directory.endsWith(separator) ? `${directory}${file}` : `${directory}${separator}${file}`;
}

/**
 * The next assistant message for one request. On a question about the practice note it calls the
 * app's folder list, then reads the note in the first allowed folder, then answers with the phrase
 * the tool returned. A refused or failed tool call is answered in words and never guessed.
 */
export function planPilotCompletion(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = (Array.isArray(body?.tools) ? body.tools : []).map((tool) => tool?.function ?? tool).filter((tool) => tool?.name);
  const lastUser = messages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === 'user').at(-1);
  const userText = lastUser ? text(lastUser.message.content) : '';
  if (!userText.toLowerCase().includes('practice note') && !userText.includes(PRACTICE_FILE)) return planCompletion(body);

  const since = lastUser ? messages.slice(lastUser.index + 1) : [];
  const calls = new Map(since.flatMap((message) => message.tool_calls ?? []).map((entry) => [entry.id, entry.function?.name ?? '']));
  const results = since.filter((message) => message.role === 'tool').map((message) => ({ name: calls.get(message.tool_call_id) ?? '', body: text(message.content) }));
  const phrase = results.map(({ body: result }) => /Receipt phrase:\s*([\w-]+)/.exec(result)?.[1]).find(Boolean);
  if (phrase) return { role: 'assistant', content: `${ANSWER_PREFIX} ${phrase}. I read it from ${PRACTICE_FILE} with the connected app.` };

  const reader = tools.find((tool) => /(?:^|_)read_file$/.test(tool.name));
  const lister = tools.find((tool) => /(?:^|_)get_allowed_directories$/.test(tool.name));
  if (!reader) return { role: 'assistant', content: `${COULD_NOT_READ}: no tool that reads files is connected.` };
  const listed = results.find(({ name }) => lister && name === lister.name);
  const readAttempt = results.find(({ name }) => name === reader.name);
  const lastResult = results.at(-1);
  const directory = listed ? firstAllowedDirectory(listed.body) : undefined;
  if (readAttempt || (lastResult && (lastResult !== listed || !directory))) {
    return { role: 'assistant', content: `${COULD_NOT_READ}: ${lastResult.body.replace(/\s+/g, ' ').trim().slice(0, 200)}` };
  }
  if (lister && !listed) return call(lister.name, {});
  return call(reader.name, { path: directory ? joinPath(directory, PRACTICE_FILE) : PRACTICE_FILE });
}
