/**
 * What a model does with the requests of FLUJO's "Test model" button, for the
 * local Anthropic stand-in: it answers the ping, then calls the diagnostic tool
 * once with the requested arguments and repeats the receipt from its result.
 * Returns undefined for any other request.
 */
import { textOf } from '../../../scripts/anthropic-stand-in.mjs';

type Message = { role: string; content: unknown };
type Body = { messages: Message[]; tools?: Array<{ name: string }> };

export function testModelReply(raw: unknown): { blocks: Array<{ type: string; [key: string]: unknown }> } | undefined {
  const body = raw as Body;
  const lastUser = [...body.messages].reverse().find(message => message.role === 'user');
  if (!lastUser) return undefined;
  const blocks = Array.isArray(lastUser.content) ? lastUser.content as Array<{ type: string; content?: unknown }> : [];
  const result = blocks.find(block => block.type === 'tool_result');
  const receipt = result && /flujo-tool-[0-9a-f-]{36}/.exec(JSON.stringify(result.content))?.[0];
  if (receipt) return { blocks: [{ type: 'text', text: receipt }] };
  const prompt = body.messages.filter(message => message.role === 'user').map(message => textOf(message.content)).join('\n');
  const requestId = /requestId "([0-9a-f-]{36})"/.exec(prompt)?.[1];
  const tool = (body.tools ?? []).find(entry => entry.name.includes('verify_tool_round_trip'));
  if (requestId && tool) return { blocks: [{ type: 'tool_use', name: tool.name, input: { requestId, payload: { values: [2, 3] } } }] };
  if (prompt.includes('Reply with the single word: pong')) return { blocks: [{ type: 'text', text: 'pong' }] };
  return undefined;
}
