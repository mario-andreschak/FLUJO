import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
// Type-only imports (erased at compile time, so they don't trigger the ESM
// runtime-load issue that forces the Agent SDK itself to be imported lazily).
import type Anthropic from '@anthropic-ai/sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { getRunResourceSettings } from '@/backend/services/runResources';
import { boundToolResult } from '@/backend/services/runResources/boundToolResult';
import { DEFAULT_TOOL_CALL_TIMEOUT_SECONDS } from '@/shared/types/mcp';
import { FlujoChatMessage } from '@/shared/types/chat';
import { CompletionAdapter, CompletionInput, CompletionResult, ToolResourceMarker } from './types';
import { extractText, extractImageParts, toAnthropicImageMediaType, truncateForPrompt } from './messageUtils';
import { buildToolInputShape, embedSchemaInDescription } from './jsonSchemaToZod';
import { mapSdkUsage, type SdkUsage } from './claudeUsage';
import {
  sessionKey,
  computePrefixHash,
  findReusableSession,
  recordSession,
  invalidateSession,
} from './claudeSessionStore';
import { DEFAULT_AGENTIC_MAX_TURNS } from '@/shared/types/model/model';

const log = createLogger('backend/services/model/adapters/claudeSubscriptionAdapter');

// Bound the agentic loop when the caller doesn't specify a cap. Aligned with the
// system default so behaviour is consistent whether or not maxTurns is threaded.
// In practice ModelHandler always resolves and passes a positive maxTurns, so
// this fallback is only a safety net.
const DEFAULT_MAX_TURNS = DEFAULT_AGENTIC_MAX_TURNS;

// Name of the in-process MCP server we expose FLUJO's tools through. The Agent
// SDK prefixes the model-facing tool names as `mcp__<server>__<tool>`.
const SDK_SERVER_NAME = 'flujo';

// Claude Code's built-in tool suite. The Agent SDK advertises these to the model
// BY DEFAULT, independent of which FLUJO tools a node bound — so without explicit
// suppression even a tools-less Process Node is offered Bash/Read/Write/etc., the
// model tries to call them, and `canUseTool` denies each with
// "...is not permitted for this node." (issue #166). We suppress them two ways:
// `options.tools = []` (SDK 0.3.x: "[] disables all built-in tools") AND this
// explicit `disallowedTools` list as drift-proof defence-in-depth, so a future
// SDK default can't silently re-expose one. Names taken from the Claude Code /
// Agent SDK built-in set; harmless if a name isn't present in a given version.
const CLAUDE_BUILTIN_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'KillBash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookRead',
  'NotebookEdit',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
  'ExitPlanMode',
];

// Keep tool names under Anthropic's 128-char limit with room for the
// `mcp__flujo__` prefix the SDK adds.
const MAX_TOOL_NAME_LEN = 110;

// Per-item caps for the tool exchanges rendered into the flattened prompt
// (issue #160). A prior tool result (a directory tree, a large file read) or an
// oversized tool-call args payload (write-file-style calls carry whole file
// contents) would otherwise dominate the single-user-message prompt. Aligned
// with the debugger's WIRE_CONTENT_MAX = 4000 spirit; args get a smaller cap
// because they are usually short and the result is what carries the evidence.
const TOOL_RESULT_MAX_CHARS = 4000;
const TOOL_ARGS_MAX_CHARS = 2000;

// Separator between rendered history entries in the flattened prompt (issue
// #296). A blank line alone did not read as a hard boundary: entries ran into
// one another and the whole block looked like one continuous script to keep
// writing. An explicit rule makes each entry a discrete record.
const ENTRY_SEPARATOR = '\n===\n';

// Envelope + instruction wrapped around a flattened history that CONTAINS TOOL
// EXCHANGES (issue #296). Without it, the transcript notation was a few-shot
// demonstration that "an assistant acts by writing an action line as text": the
// model would emit `Assistant [tool call] mcp__flujo__<tool>` prose (sometimes
// followed by its own leaked internal invoke syntax) instead of calling the
// tool, and the CLI then failed the turn with "The model's tool call could not
// be parsed (retry also failed)". That malformed prose was persisted and
// re-flattened next turn as an even stronger example, so it compounded.
// Applied ONLY on the tool-bearing path — see the fast paths in buildUserMessage.
const HISTORY_OPEN = '<conversation_history>';
const HISTORY_CLOSE = '</conversation_history>';
const HISTORY_PREAMBLE =
  'This is a RECORD of the conversation so far, including actions already taken and their ' +
  'results. It is reference material, NOT a template to continue: never write `[prior action]` ' +
  'lines, `Human:`/`Assistant:` prefixes, or any other tool-call notation as text in your ' +
  'reply. To take a new action, call the tool through your normal tool interface.';

/**
 * Wrap the rendered entries in the inert-record envelope (issue #296).
 */
function wrapHistory(body: string): string {
  return `${HISTORY_OPEN}\n${HISTORY_PREAMBLE}\n\n${body}\n${HISTORY_CLOSE}`;
}

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Build a readable, collision-free `<server>__<tool>` name for a tool exposed to
 * Claude. Unlike FLUJO's hashed model-facing names, this is human-readable in the
 * conversation; the handler closes over the real (server, tool), so the name only
 * has to be unique and charset/length-safe — not decodable.
 */
function buildReadableName(server: string, tool: string, used: Set<string>): string {
  let base = `${sanitizeName(server)}__${sanitizeName(tool)}`;
  if (base.length > MAX_TOOL_NAME_LEN) base = base.slice(0, MAX_TOOL_NAME_LEN);
  let name = base;
  let i = 2;
  while (used.has(name)) {
    const suffix = `_${i++}`;
    name = base.slice(0, MAX_TOOL_NAME_LEN - suffix.length) + suffix;
  }
  used.add(name);
  return name;
}

function isHandoffName(name: string): boolean {
  return name.startsWith('handoff_to_') || name === 'handoff';
}

/**
 * Flatten FLUJO's OpenAI-format messages into the Agent SDK's structured input:
 * a hoisted `systemPrompt` plus the content for a single streamed user message.
 * System messages are hoisted; the remaining user/assistant turns are rendered
 * into one text block (the SDK is driven with a single user message, so prior
 * assistant turns are replayed as text rather than as distinct turns). Images
 * from user turns become image content blocks so a vision-capable Claude can
 * see them.
 *
 * PRIOR TOOL EXCHANGES ARE RENDERED AS TEXT (issue #160). The SDK's single-
 * user-message channel has no way to replay prior `tool_use`/`tool_result` as
 * NATIVE turns (that needs an SDK session `resume`, tracked as #154, and even
 * then only within the same node). Dropping them entirely — as this adapter
 * used to — silently violated `full-history`'s documented contract: a
 * downstream node reading the whole conversation saw only assistant PROSE and
 * none of a predecessor node's tool calls or their results, so its model
 * re-enacted the work from scratch. We now serialise each prior assistant
 * tool-call turn and each `tool` result into the flattened transcript (with
 * size caps) so the model actually sees the evidence its predecessor gathered.
 * This is scoped to PRIOR/SETTLED turns only — the SDK owns the current node's
 * OWN live tool loop and always sees its full params/results (this function is
 * only ever handed history that precedes that live loop).
 *
 * INERT-RECORD FRAMING (issue #296). A tool-bearing history is wrapped in a
 * `<conversation_history>` envelope carrying HISTORY_PREAMBLE, and its entries
 * are separated by `===`. Prior actions render as `[prior action] <name>` /
 * `arguments: …` / `[prior action result] <name>` rather than the former
 * `Assistant [tool call] <name>(<args>)` call-expression form: that form was a
 * few-shot demonstration of "act by writing an action line", and models followed
 * it — emitting the notation as prose instead of invoking, which the CLI then
 * failed to parse. See the constants above for the full failure chain.
 *
 * When there are no tool exchanges the tool-rendering branches are never taken
 * and no envelope is added, and when there are also no images the content is a
 * plain string — byte-for-byte the prompt the old flat-string path produced — so
 * ordinary text/image runs are unchanged (preserving the #89/#87 prefix-cache
 * stability); only histories that carry tool exchanges change.
 *
 * QUADRATIC RE-SEND (#87) and its fix (#154): by DEFAULT every node call spawns
 * a fresh `query()` (a new `claude` subprocess, no `resume`) and re-sends the
 * ENTIRE prior conversation flattened here. Only `systemPrompt` + tool defs form
 * a cacheable prefix; the conversation body is re-tokenized each turn, so
 * cumulative input grows ~O(n^2) with conversation length. The reporting side of
 * this was fixed by surfacing cache RE-READ tokens separately (see claudeUsage
 * .ts) so warmed-cache reads stop inflating the headline.
 *
 * #154 STATUS: the efficiency fix — reuse the SDK session per `(conversationId,
 * nodeId)` via `resume` and send only the per-turn delta — is now IMPLEMENTED,
 * behind the experimental `claudeSessionResume` setting (threaded as
 * `CompletionInput.sessionResume`). When it is ON and a reusable session exists,
 * `createCompletion` resumes that session (so its prior turns are loaded
 * natively) and this function is called only over the DELTA messages. When it is
 * OFF — the default — this flatten path over the whole history remains the
 * always-correct behaviour and the fallback whenever a session can't be reused
 * (prefix change, history divergence, error, handoff, or a scoped wire view).
 */
export function buildUserMessage(
  messages: OpenAI.ChatCompletionMessageParam[],
  /**
   * Captured run resources for oversized PRIOR tool results/args, keyed by the
   * producing tool_call_id (issue #168). When an oversized result/args has a
   * captured entry, render a head excerpt + a `flujo://run/...` marker the model
   * can dereference via `read_resource`, instead of a plain `…[truncated]`.
   * Absent (or no matching entry) ⇒ byte-identical plain truncation. This only
   * ever sees PRIOR/SETTLED turns (the SDK owns the current node's live loop),
   * so the current node's in-flight args/results are never rewritten.
   */
  resourceMarkers?: Map<string, ToolResourceMarker>,
): {
  systemPrompt?: string;
  content: string | Anthropic.ContentBlockParam[];
} {
  const systemParts: string[] = [];
  // Each already-formatted transcript line, in original order. A plain text
  // turn renders as before (`Human: …` / `Assistant: …`); an assistant tool-
  // call turn and a `tool` result each render as their own line (#160).
  const lines: string[] = [];
  const images: ReturnType<typeof extractImageParts> = [];

  // Whether any tool exchange was rendered, and how many plain text turns there
  // were. Together these select the byte-identical no-tool fast paths below.
  let toolActivity = false;
  let plainTurns = 0;
  let firstPlainText = '';

  // Map tool_call_id -> the tool name from the assistant turn that issued it,
  // so a `tool` result can be labelled with a meaningful name rather than the
  // opaque call id.
  const callNames = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.type === 'function') callNames.set(tc.id, tc.function.name);
      }
    }
  }

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = extractText(msg.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (msg.role === 'tool') {
      // A prior tool RESULT: render it as text so a downstream full-history
      // reader sees what the tool returned (#160). Truncated to a cap so a
      // large payload can't dominate the flattened prompt.
      toolActivity = true;
      const name = callNames.get(msg.tool_call_id) ?? msg.tool_call_id;
      const fullResult = extractText(msg.content ?? '');
      const entry = resourceMarkers?.get(msg.tool_call_id)?.result;
      if (entry && fullResult.length > TOOL_RESULT_MAX_CHARS) {
        // Head excerpt + dereferenceable marker (#168): the full payload was
        // captured as a run resource, so point the model at it via read_resource
        // instead of silently dropping the tail.
        lines.push(
          `[prior action result] ${name}\n${fullResult.slice(0, TOOL_RESULT_MAX_CHARS)}\n…\n` +
          `[full content stored as run resource ${entry.uri} — call read_resource with this uri to read it]`,
        );
      } else {
        lines.push(`[prior action result] ${name}\n${truncateForPrompt(fullResult, TOOL_RESULT_MAX_CHARS)}`);
      }
      continue;
    }
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;

    const text = extractText(msg.content ?? '');
    if (text) {
      plainTurns++;
      if (plainTurns === 1) firstPlainText = text;
      lines.push(`${msg.role === 'assistant' ? 'Assistant' : 'Human'}: ${text}`);
    }
    // A prior assistant TOOL-CALL turn (content is typically '' so it produced
    // no text line above): render each call so the model sees the actions its
    // predecessor took, not just its prose (#160).
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.type !== 'function') continue;
        toolActivity = true;
        const fullArgs = tc.function.arguments ?? '';
        const argsEntry = resourceMarkers?.get(tc.id)?.args;
        if (argsEntry && fullArgs.length > TOOL_ARGS_MAX_CHARS) {
          // Head excerpt + marker for oversized captured args (#168).
          lines.push(
            `[prior action] ${tc.function.name}\narguments: ${fullArgs.slice(0, TOOL_ARGS_MAX_CHARS)}\n…\n` +
            `[full arguments stored as run resource ${argsEntry.uri} — call read_resource with this uri to read them]`,
          );
        } else {
          const args = truncateForPrompt(fullArgs, TOOL_ARGS_MAX_CHARS);
          lines.push(`[prior action] ${tc.function.name}\narguments: ${args}`);
        }
      }
    }
    if (msg.role === 'user') images.push(...extractImageParts(msg.content));
  }

  // Three render paths, deliberately ordered so BOTH tool-free ones stay
  // byte-identical to the pre-#296 output (prefix-cache stability for ordinary
  // text runs — the affected set is exactly the histories that carry tool
  // exchanges, which are the ones that provoked the imitation failure):
  //   - tool-bearing: entries separated by `===` inside the inert-record
  //     envelope (#296),
  //   - tool-free single turn: the raw text, no `Human:` prefix (pre-#160),
  //   - tool-free multi-turn: prefixed lines joined by blank lines (#160).
  const promptText = toolActivity
    ? wrapHistory(lines.join(ENTRY_SEPARATOR))
    : plainTurns <= 1
      ? firstPlainText
      : lines.join('\n\n');

  const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

  if (images.length === 0) {
    return { systemPrompt, content: promptText };
  }

  const blocks: Anthropic.ContentBlockParam[] = [];
  if (promptText) blocks.push({ type: 'text', text: promptText });
  for (const img of images) {
    if (img.base64) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: toAnthropicImageMediaType(img.mimeType), data: img.base64 },
      });
    } else {
      blocks.push({ type: 'image', source: { type: 'url', url: img.url } });
    }
  }
  return { systemPrompt, content: blocks };
}

interface ToolInteraction {
  id: string;
  name: string;
  argsJson: string;
  resultContent: string;
}

/**
 * Claude Subscription adapter — drives a Claude Pro/Max subscription through the
 * Claude Agent SDK (which wraps the `claude` CLI). Authentication is the OAuth
 * token from `claude setup-token`, supplied per-call via the subprocess `env`
 * (CLAUDE_CODE_OAUTH_TOKEN).
 *
 * Tool calling is agentic. FLUJO's tools are re-exposed to the SDK as an
 * in-process MCP server whose handlers dispatch to `mcpService` — so every tool
 * call executes AND is observed inside FLUJO. Because the calls route through our
 * own handlers, we capture each call + result there (structured) rather than
 * parsing the SDK's streamed messages. Each captured assistant/tool message is
 * BOTH streamed live (via `onTranscriptMessage`, so the UI sees tool calls as
 * they happen instead of an hour later) AND collected into the returned
 * `transcript` for persistence. Handoff tools are exposed too: invoking one
 * records the handoff and ends the run, surfacing EVERY handoff call of the
 * routing turn as a tool_call so FLUJO's edge routing fires — repeated calls to
 * a spawnable sub-agent become parallel briefed lanes (issue #156).
 * `canUseTool` auto-approves FLUJO's tools (the seam for an interactive approval
 * UI); `maxTurns` bounds the loop.
 *
 * Input is delivered through the SDK's streaming-input channel (an
 * `AsyncIterable<SDKUserMessage>`) rather than a flat string prompt, so a
 * multimodal user turn can carry image content blocks alongside its text.
 */
export class ClaudeSubscriptionAdapter implements CompletionAdapter {
  async createCompletion({
    model,
    apiKey,
    messages,
    tools,
    toolNameMap,
    localToolExecutors,
    maxTurns,
    requestToolApproval,
    onTranscriptMessage,
    signal,
    conversationId,
    nodeId,
    runResourceMarkers,
    sessionResume,
    // Note: `maxTokens` is intentionally NOT destructured/applied here — and
    // neither is `temperature`. This is an agentic adapter: unlike the
    // request/response adapters (OpenAI/Anthropic/Gemini) that issue a single
    // API call and can pass max_tokens/temperature per request, the Claude
    // Agent SDK's query() loop owns sampling and output length internally, so an
    // output-token cap has no single request to attach to. Only `maxTurns` (the
    // agentic iteration bound) is honoured here. A hard `maxTokens` cap would
    // require SDK-managed sampling-control support that does not exist today; if
    // that is ever desired, revisit this seam (issues #173 and #191).
  }: CompletionInput): Promise<CompletionResult> {
    // Lazy-load the Agent SDK: it ships as ESM, so importing it at module scope
    // would break the (CommonJS) Jest transform for every module that merely
    // references the adapter factory.
    const { query, createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');

    // The FULL flatten of the whole history. `systemPrompt` is the hoisted,
    // prefix-stable system block (unchanged turn to turn for a given node); its
    // `content` is the always-correct fallback we send when NOT resuming.
    const { systemPrompt, content: fullContent } = buildUserMessage(messages, runResourceMarkers);

    // #154 session tracking. When the caller identifies the conversation+node,
    // key a reusable Agent SDK session on a hash of the reusable prefix
    // (systemPrompt + tool set). We capture the SDK `session_id` below and, once
    // the run succeeds, record it (watermarked by the total message count the
    // session now reflects) so a later turn of the SAME single-node Flow can
    // `resume` instead of re-flattening the whole history. `findReusableSession`
    // surfaces whether reuse is possible this turn — used both as the Phase-0
    // measurement signal AND, when `sessionResume` is on, to actually resume.
    const sessionTracking =
      conversationId && nodeId
        ? {
            key: sessionKey(conversationId, nodeId),
            prefixHash: computePrefixHash(
              systemPrompt,
              (tools ?? []).filter(t => t.type === 'function').map(t => t.function.name),
            ),
          }
        : undefined;
    let capturedSessionId: string | undefined;

    // Decide the send path (#154). When session reuse is enabled AND a reusable
    // session exists for this (conversation, node) with a matching prefix and a
    // non-shrunk history, RESUME it and send only the messages appended since
    // the session's watermark (`seenMessageCount`) — the SDK already holds every
    // prior turn NATIVELY, so re-sending them would duplicate context. Otherwise
    // fall back to the full flatten (the always-correct path). The systemPrompt
    // is still passed on resume: the SDK applies it per-invocation (it is not
    // part of the persisted transcript), and the prefix-hash match guarantees it
    // is byte-identical to what the session was built with.
    let resumeSessionId: string | undefined;
    let userContent: string | Anthropic.ContentBlockParam[] = fullContent;
    if (sessionResume && sessionTracking) {
      const reusable = findReusableSession(
        sessionTracking.key,
        sessionTracking.prefixHash,
        messages.length,
      );
      // Only resume when there are genuinely new messages beyond the watermark;
      // an empty delta would mean "nothing new to say" (degenerate) — fall back
      // to the full flatten rather than send an empty turn.
      if (reusable && messages.length > reusable.seenMessageCount) {
        const delta = buildUserMessage(messages.slice(reusable.seenMessageCount), runResourceMarkers);
        // `content` is a string OR a content-block array; both expose `.length`,
        // so a non-empty delta means there is genuinely something new to send.
        if (delta.content.length > 0) {
          resumeSessionId = reusable.sessionId;
          userContent = delta.content;
          log.debug('Claude subscription resuming session (#154)', {
            key: sessionTracking.key,
            resumeSessionId,
            seenMessageCount: reusable.seenMessageCount,
            deltaMessages: messages.length - reusable.seenMessageCount,
          });
        }
      }
    }

    const usedNames = new Set<string>();
    // Spawn-with-brief (issue #156): a routing model may call handoff tools
    // SEVERAL times — in one turn (parallel tool_use blocks) or one per turn,
    // which is how models under the SDK's agentic loop usually work. Collect
    // them ALL (in call order) instead of only the first; the message loop ends
    // the run when the model produces a turn WITHOUT another handoff call (or
    // the SDK loop ends), so a model can keep queueing spawn lanes.
    const handoffCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    // Local mirror of MAX_DYNAMIC_FANOUT_LANES (SubflowNode) — prep re-caps the
    // briefs anyway; this only stops a runaway spawn loop from burning turns.
    const MAX_SPAWN_CALLS = 32;
    // Set when a PLAIN (non-spawnable) handoff tool fires: those keep the
    // legacy semantics — the run ends at the next streamed message, no extra
    // model turn. Spawnable targets instead end when the model stops calling.
    let endSpawning = false;
    const abortController = new AbortController();
    // Chain the caller's cancellation signal (Stop button) onto the controller
    // that owns the whole agentic loop — this is the largest otherwise
    // un-interruptible window (the SDK can run tools/turns for a long time).
    // A handoff abort is intentional and handled separately (handoffCalls set).
    const onExternalAbort = () => abortController.abort();
    if (signal?.aborted) {
      abortController.abort();
    } else {
      signal?.addEventListener('abort', onExternalAbort, { once: true });
    }

    // The conversation messages produced by this run, in order. Each is given a
    // stable id and streamed live as it is recorded; the same array is returned
    // as the transcript so the caller can persist (and re-emit) them with
    // matching ids. `txSeq` keeps timestamps monotonic within the run.
    const transcript: FlujoChatMessage[] = [];
    const baseTs = Date.now();
    let txSeq = 0;
    const recordMessage = (msg: OpenAI.ChatCompletionMessageParam): void => {
      const full = { ...msg, id: `m_${uuidv4()}`, timestamp: baseTs + txSeq++ } as FlujoChatMessage;
      transcript.push(full);
      onTranscriptMessage?.(full);
    };
    // Materialize an executed (or rejected) tool call as the OpenAI-shaped
    // assistant(tool_call) + tool(result) pair, streaming both live.
    const recordToolPair = (ti: ToolInteraction): void => {
      recordMessage({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: ti.id, type: 'function', function: { name: ti.name, arguments: ti.argsJson } }],
      });
      recordMessage({ role: 'tool', tool_call_id: ti.id, content: ti.resultContent });
    };

    // Build the in-process MCP server from the node's tools. MCP tools dispatch to
    // mcpService; handoff tools record the handoff and abort; caller-defined local
    // tools (e.g. the flow generator's marketplace search/install) dispatch to the
    // executor supplied via localToolExecutors. Anything else is omitted from an
    // agentic run.
    const sdkTools = (tools ?? [])
      .filter(t => t.type === 'function')
      .map(t => {
        const fnName = t.function.name;
        const handoff = isHandoffName(fnName);
        const decoded = toolNameMap?.[fnName];
        const localExec = localToolExecutors?.[fnName];
        if (!handoff && !decoded && !localExec) return null;

        // Build the Zod raw shape and, when a composed/ref schema couldn't be
        // faithfully translated, surface the original JSON Schema in the
        // description so the model still sees the real contract (issue #232).
        const { shape: schemaShape, fallbackSchema } = buildToolInputShape(t.function.parameters);
        const description = embedSchemaInDescription(t.function.description ?? '', fallbackSchema);

        if (handoff) {
          // A spawnable sub-agent's handoff tool carries a `task` param (issue
          // #156); a plain handoff tool is parameter-less. The two end the run
          // differently (see below).
          const spawnable = !!(
            (t.function.parameters as { properties?: Record<string, unknown> } | undefined)?.properties?.task
          );
          // Keep the exact name so FLUJO's `handoff_to_<nodeId>` routing matches.
          return tool(fnName, description, schemaShape, async (args: Record<string, unknown>): Promise<CallToolResult> => {
            // Spawn-with-brief (issue #156): EVERY handoff call counts — a model
            // splitting work calls the same spawn tool once per brief, and
            // dropping the extras silently discarded its work.
            handoffCalls.push({ name: fnName, args: args ?? {} });
            log.debug('Claude subscription requested handoff', { tool: fnName, callIndex: handoffCalls.length, spawnable });
            // Do NOT abort here. Aborting inside the tool handler tears down the
            // SDK control stream mid-permission-round-trip and surfaces the
            // benign "permission stream closed" error. Instead record the call
            // and return cleanly; the message loop ends the run at the right
            // moment (see the for-await checks). For a SPAWNABLE target the
            // result text invites further calls, so a model that works one tool
            // call per turn can still queue several parallel workers; a plain
            // handoff keeps the legacy immediate end.
            if (!spawnable) {
              endSpawning = true;
              return { content: [{ type: 'text', text: 'Handing off.' }] };
            }
            return {
              content: [{
                type: 'text',
                text: 'Worker spawned for this task. Call this tool again right now to spawn another parallel worker (one call per task). When you stop calling it, all spawned workers run concurrently and their merged results come back.',
              }],
            };
          });
        }

        if (localExec) {
          // Caller-executed virtual tool: run the supplied executor in-loop and
          // hand its JSON result back to the SDK. Keep the exact name — these
          // names are already OpenAI-safe and the caller keys executors by them.
          return tool(fnName, description, schemaShape, async (args: Record<string, unknown>): Promise<CallToolResult> => {
            log.debug('Claude subscription local tool call', { tool: fnName });
            let resultContent: string;
            let isError = false;
            try {
              resultContent = JSON.stringify(await localExec(args ?? {}));
            } catch (err) {
              resultContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
              isError = true;
            }
            recordToolPair({
              id: `call_${uuidv4()}`,
              name: fnName,
              argsJson: JSON.stringify(args ?? {}),
              resultContent,
            });
            return isError
              ? { content: [{ type: 'text', text: resultContent }], isError: true }
              : { content: [{ type: 'text', text: resultContent }] };
          });
        }

        const { server, tool: originalTool, timeout, nodeId: callerNodeId } = decoded!;
        const readableName = buildReadableName(server, originalTool, usedNames);
        return tool(readableName, description, schemaShape, async (args: Record<string, unknown>): Promise<CallToolResult> => {
          log.debug('Claude subscription tool call', { server, tool: originalTool, exposedAs: readableName });
          // Same timeout policy as the OpenAI-path tool loop: the MCP node's
          // toolTimeout (seconds, -1 = none), defaulting to 5 minutes.
          const result = await mcpService.callTool(server, originalTool, args ?? {}, timeout ?? DEFAULT_TOOL_CALL_TIMEOUT_SECONDS, undefined, callerNodeId);
          // Stable lineage id, generated up front so a spilled run resource is
          // keyed by the SAME toolCallId this pair is recorded under (#251).
          const callId = `call_${uuidv4()}`;
          let callResult: CallToolResult;
          let resultContent: string;
          if (result.success) {
            callResult = result.data as CallToolResult;
            // Match the OpenAI path's tool-result encoding (JSON of the result data).
            resultContent = JSON.stringify(result.data);
            // Tool-boundary bound (#251): this path bypasses ModelHandler's
            // processToolCalls, so without bounding here the guarantee would
            // silently not apply on Claude-subscription runs. Spill oversized
            // results to a run resource and show a head+tail preview instead.
            if (conversationId) {
              try {
                const settings = await getRunResourceSettings();
                const bounded = await boundToolResult({
                  conversationId,
                  toolCallId: callId,
                  server,
                  toolName: originalTool,
                  nodeId: callerNodeId,
                  content: resultContent,
                  settings,
                });
                if (bounded.spilled) {
                  resultContent = bounded.content;
                  // callResult is what the SDK feeds the MODEL, so it must be
                  // bounded too (not just the recorded transcript) or the model
                  // still sees the full result on this path.
                  callResult = { content: [{ type: 'text', text: bounded.content }] };
                }
              } catch (err) {
                log.warn('boundToolResult failed on subscription path; keeping full result', err);
              }
            }
          } else {
            resultContent = `Error: ${result.error ?? 'Unknown error'}`;
            callResult = { content: [{ type: 'text', text: resultContent }], isError: true };
          }
          recordToolPair({
            id: callId,
            name: readableName,
            argsJson: JSON.stringify(args ?? {}),
            resultContent,
          });
          return callResult;
        });
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);

    const mcpServers = sdkTools.length > 0
      ? { [SDK_SERVER_NAME]: createSdkMcpServer({ name: SDK_SERVER_NAME, version: '1.0.0', tools: sdkTools }) }
      : undefined;

    // Replace the subprocess env wholesale (per SDK contract): inherit ours, add
    // the OAuth token, and drop ANTHROPIC_API_KEY so it can't take precedence.
    const childEnv: Record<string, string | undefined> = { ...process.env };
    childEnv.CLAUDE_CODE_OAUTH_TOKEN = apiKey;
    delete childEnv.ANTHROPIC_API_KEY;

    const hasImages = typeof userContent !== 'string';
    log.debug('createCompletion via Claude Agent SDK', {
      model: model.name,
      toolCount: sdkTools.length,
      hasSystem: Boolean(systemPrompt),
      hasImages,
      maxTurns: maxTurns && maxTurns > 0 ? maxTurns : DEFAULT_MAX_TURNS,
    });

    // Drive the SDK via its streaming-input channel with a single user message.
    // The generator yields once then completes, signaling end-of-input so the
    // SDK processes the turn (and runs the agentic tool loop) to completion.
    async function* promptStream(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: userContent },
      };
    }

    const response = query({
      prompt: promptStream(),
      options: {
        model: model.name,
        env: childEnv,
        abortController,
        maxTurns: maxTurns && maxTurns > 0 ? maxTurns : DEFAULT_MAX_TURNS,
        // #154: resume the persisted session so its prior turns are loaded
        // NATIVELY and only the delta (userContent above) is sent this turn.
        // forkSession is left unset ⇒ the resumed session CONTINUES (same id,
        // appends), which is what accumulates context across turns.
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        // Disable Claude Code's built-in tool suite so ONLY FLUJO's MCP tools are
        // offered to the model (issue #166). `tools: []` is the SDK-documented
        // "disable all built-ins" switch; `disallowedTools` explicitly removes the
        // known built-ins from the model's context as drift-proof defence-in-depth
        // (belt-and-suspenders with the canUseTool deny below). A tools-less node
        // therefore exposes zero tools and the model can't "know about" any it
        // isn't permitted to call.
        tools: [],
        disallowedTools: CLAUDE_BUILTIN_TOOLS,
        // NOTE: deliberately NOT setting `allowedTools` — entries there are
        // auto-allowed and BYPASS canUseTool, which would skip the approval gate.
        // canUseTool is the sole authority: it auto-allows our tools when no gate
        // is wired, and blocks for approval when it is.
        ...(mcpServers ? { mcpServers } : {}),
        canUseTool: async (toolName, input, opts) => {
          if (!toolName.startsWith(`mcp__${SDK_SERVER_NAME}__`)) {
            return { behavior: 'deny', message: `Tool ${toolName} is not permitted for this node.` };
          }
          // Human-in-the-loop: when an approval gate is wired, block until the
          // user decides (surfaced to FLUJO's tool-approval UI). Otherwise auto-allow.
          if (requestToolApproval) {
            const readableName = toolName.replace(`mcp__${SDK_SERVER_NAME}__`, '');
            const { approved, feedback } = await requestToolApproval({
              id: opts.toolUseID,
              name: readableName,
              args: (input ?? {}) as Record<string, unknown>,
            });
            if (approved) {
              return { behavior: 'allow', updatedInput: input };
            }
            // Issue #247: carry the optional rejection reason back to the model
            // so it can adjust; otherwise keep the original fixed rejection text.
            const rejectionText = feedback
              ? `User rejected this tool call: ${feedback}`
              : 'Tool call rejected by the user.';
            // On rejection the SDK never calls the tool handler, so record the
            // rejected call here — otherwise it (and the rejection) wouldn't show
            // up in the conversation transcript at all.
            recordToolPair({
              id: opts.toolUseID,
              name: readableName,
              argsJson: JSON.stringify(input ?? {}),
              resultContent: rejectionText,
            });
            return { behavior: 'deny', message: rejectionText };
          }
          return { behavior: 'allow', updatedInput: input };
        },
      },
    });

    let resultText = '';
    let accumulatedText = '';
    // Token accounting. The SDK's terminal `result` message carries the run's
    // usage, but a handoff ABORTS the loop before that message arrives — so we
    // also track per-turn usage from each assistant message as a fallback
    // (otherwise every run that ends by routing to another node reports 0
    // tokens). The fresh/cached split is computed by mapSdkUsage (see
    // claudeUsage.ts and issue #87): promptTokens is the full input context,
    // but the cheap cache RE-READ tokens are also surfaced separately so the UI
    // doesn't count them as fresh on every turn.
    let usage: SdkUsage | undefined;
    let lastTurnUsage: SdkUsage | undefined;
    let totalOutputTokens = 0;
    // Whether we streamed at least one assistant text turn live (below). If so,
    // the final answer is already in the transcript and we must not re-emit the
    // concatenated text at the end (it would duplicate in the UI).
    let streamedText = false;

    // The message loop, extracted so an external cancellation can race it: the
    // SDK does NOT reliably throw when its abortController fires mid-turn — the
    // iterator often just ends "normally" (no result message) after draining,
    // which previously made a cancelled run look like a completed one built
    // from partial text. Racing the loop against the signal both surfaces the
    // cancellation AND returns within the cancel-poll cadence instead of
    // waiting out the subprocess teardown.
    const messageLoop = async (): Promise<void> => {
      for await (const message of response) {
        // Capture the SDK session id (present on system/assistant/result
        // messages) for the #154 session registry, before any early break.
        const sid = (message as { session_id?: unknown }).session_id;
        if (typeof sid === 'string' && sid) capturedSessionId = sid;
        // Once cancelled, stop recording/streaming anything the detached loop
        // may still drain out of the dying subprocess.
        if (signal?.aborted) break;
        // Handoff end conditions (issue #156). A PLAIN handoff (endSpawning)
        // ends the run at the next streamed message, exactly like before —
        // no extra model turn, no post-handoff narration. SPAWN handoffs
        // instead let the model keep calling the spawn tool (one call per
        // turn, or several tool_uses in one turn) and end the run when the
        // model produces a turn WITHOUT another handoff call — or at the
        // runaway cap.
        if (handoffCalls.length > 0 && (endSpawning || handoffCalls.length >= MAX_SPAWN_CALLS)) {
          abortController.abort();
          break;
        }
        if (message.type === 'assistant') {
          const assistant = (message as { message?: { content?: unknown; usage?: SdkUsage } }).message;
          const content = assistant?.content;
          let turnText = '';
          let turnHandoffUses = 0;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === 'text' && typeof block.text === 'string') turnText += block.text;
              // SDK MCP tool names arrive namespaced (mcp__<server>__<tool>),
              // so match handoff tool_use blocks on the bare name.
              if (block?.type === 'tool_use' && typeof (block as { name?: unknown }).name === 'string') {
                const rawName = (block as { name: string }).name;
                const bare = rawName.includes('__') ? rawName.slice(rawName.lastIndexOf('__') + 2) : rawName;
                if (isHandoffName(bare)) turnHandoffUses++;
              }
            }
          }
          // Spawning ended: the model produced a turn with no further handoff
          // call after spawning at least one worker. Stop BEFORE accumulating
          // it so the model can't narrate post-handoff.
          if (handoffCalls.length > 0 && turnHandoffUses === 0) {
            abortController.abort();
            break;
          }
          // Mid-spawn narration (between successive spawn calls) is mid-action
          // plumbing, not the node's answer — the routing turn's own prose
          // (before any handoff was recorded) is still preserved below.
          if (turnText && handoffCalls.length === 0) {
            accumulatedText += turnText;
            // Stream THIS turn's narration live as its own assistant message, so
            // the UI shows Claude's step-by-step reasoning interleaved with the
            // tool calls (which already stream via recordToolPair) instead of
            // arriving as one block after the whole (possibly long) run. Text
            // blocks precede tool_use within a turn, so this lands in the right
            // order: turn text -> tool pair -> next turn text -> ...
            recordMessage({ role: 'assistant', content: turnText });
            streamedText = true;
          }
          if (assistant?.usage) {
            lastTurnUsage = assistant.usage;
            totalOutputTokens += assistant.usage.output_tokens ?? 0;
          }
        } else if (message.type === 'result') {
          usage = (message as { usage?: SdkUsage }).usage;
          if (message.subtype === 'success') {
            resultText = (message as { result?: string }).result ?? '';
          } else if (handoffCalls.length === 0) {
            const errs = (message as { errors?: string[] }).errors;
            const detail = Array.isArray(errs) && errs.length ? errs.join('; ') : message.subtype;
            throw new Error(`Claude subscription run failed: ${detail}`);
          }
        }
      }
    };

    try {
      if (signal) {
        // Race the loop against cancellation. If the signal fires first we throw
        // immediately (ModelHandler maps it to 'cancelled'); the SDK's own abort
        // (chained via onExternalAbort) tears the subprocess down in the
        // background, and the detached loop's guard above keeps it from
        // recording anything more. Its eventual settle is explicitly swallowed.
        let onAbort: (() => void) | undefined;
        const cancelPromise = new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error('Claude subscription run cancelled by user.'));
          signal.addEventListener('abort', onAbort!, { once: true });
        });
        const loopPromise = messageLoop();
        try {
          await Promise.race([loopPromise, cancelPromise]);
        } finally {
          if (onAbort) signal.removeEventListener('abort', onAbort);
          loopPromise.catch(() => { /* late teardown rejection — already handled */ });
        }
        // The probe-observed SDK behavior: an aborted query can END the loop
        // normally (no throw, no result). Never let that read as success.
        if (signal.aborted && handoffCalls.length === 0) {
          throw new Error('Claude subscription run cancelled by user.');
        }
      } else {
        await messageLoop();
      }
    } catch (err) {
      // A handoff aborts the run on purpose; only genuine errors (including an
      // external cancellation, mapped to 'cancelled' by ModelHandler) propagate.
      if (handoffCalls.length === 0) {
        // Drop any tracked session on a genuine error/cancellation so a later
        // turn never resumes a corrupted or half-torn-down session (#154 — the
        // "drop the cached session on error" contract coordinated with #151).
        if (sessionTracking) invalidateSession(sessionTracking.key);
        throw err;
      }
    } finally {
      signal?.removeEventListener('abort', onExternalAbort);
    }

    const finalText = resultText || accumulatedText;
    // Prefer the result message's totals; on handoff-aborted runs fall back to
    // the last turn's context size + the summed output of all turns. cacheRead
    // is the prefix re-read cheaply from the prompt cache — kept out of the
    // "fresh" headline so a warmed-cache conversation stops reporting millions.
    const { promptTokens, completionTokens, cacheReadTokens } = mapSdkUsage(usage, {
      lastTurnUsage,
      totalOutputTokens,
    });

    // The per-tool assistant(tool_call)+tool(result) pairs, and now each turn's
    // narration text, were already recorded and streamed live as they happened
    // (see recordToolPair and the `assistant` branch above). So here we only add
    // what is NOT yet in the transcript:
    //   - a handoff tool_call (routing), with content null since the handoff
    //     turn's text — a node can legitimately answer AND hand off in one turn —
    //     already streamed above; the node's output is still `finalText` (below),
    //     which createCompletion returns separately from the transcript.
    //   - a plain-text answer ONLY when nothing streamed (e.g. the run produced
    //     no assistant text turns and only the terminal `result` carried text).
    // Re-emitting `finalText` when we already streamed it would duplicate it.
    let finalToolCalls: OpenAI.ChatCompletionMessageToolCall[] | undefined;
    if (handoffCalls.length > 0) {
      // ALL handoff calls of the routing turn, in call order (issue #156): the
      // run loop's capture turns repeated spawn calls into parallel lanes and
      // answers each id with its own tool result.
      finalToolCalls = handoffCalls.map((h) => ({
        id: `call_${uuidv4()}`,
        type: 'function' as const,
        function: { name: h.name, arguments: JSON.stringify(h.args) },
      }));
    }
    if (finalToolCalls) {
      recordMessage({ role: 'assistant', content: null, tool_calls: finalToolCalls });
    } else if (!streamedText) {
      recordMessage({ role: 'assistant', content: finalText || '' });
    }

    // #154 session bookkeeping + instrumentation. Runs AFTER the whole transcript
    // is recorded, so the watermark reflects EVERY message the session now holds:
    // this call's INPUT (`messages`) plus everything the SDK just generated
    // (`transcript`) — which the caller (ModelHandler) appends to the
    // conversation verbatim. The next turn's delta is therefore exactly the new
    // messages beyond this count. A handoff routes to a different node with fresh
    // context, so drop the session; a normal turn records the captured session
    // (same id when resumed with forkSession unset, a fresh id on a first run).
    // `reusableSessionAvailable` is logged as the measurement signal.
    if (sessionTracking) {
      const reusableSessionAvailable = Boolean(
        findReusableSession(sessionTracking.key, sessionTracking.prefixHash, messages.length),
      );
      if (handoffCalls.length > 0 || !capturedSessionId) {
        invalidateSession(sessionTracking.key);
      } else {
        recordSession(sessionTracking.key, {
          sessionId: capturedSessionId,
          prefixHash: sessionTracking.prefixHash,
          seenMessageCount: messages.length + transcript.length,
        });
      }
      log.debug('Claude session usage (#154)', {
        conversationId,
        nodeId,
        sessionResume: Boolean(sessionResume),
        resumedThisTurn: Boolean(resumeSessionId),
        reusableSessionAvailable,
        capturedSession: Boolean(capturedSessionId),
        inputMessages: messages.length,
        transcriptMessages: transcript.length,
        watermark: messages.length + transcript.length,
        promptTokens,
        cacheReadTokens,
        completionTokens,
        endedByHandoff: handoffCalls.length > 0,
      });
    }

    const completion: OpenAI.Chat.Completions.ChatCompletion = {
      id: `claude_sub_${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model.name,
      choices: [
        {
          index: 0,
          finish_reason: finalToolCalls ? 'tool_calls' : 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: finalText || null,
            refusal: null,
            ...(finalToolCalls ? { tool_calls: finalToolCalls } : {}),
          },
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        // Surface the cheap cache RE-READ subset via OpenAI's own usage detail
        // field so downstream (ModelHandler → usage totals → UI) can present a
        // "fresh (+cached)" split instead of one inflated number (#87).
        ...(cacheReadTokens > 0 ? { prompt_tokens_details: { cached_tokens: cacheReadTokens } } : {}),
      },
    };

    return { completion, transcript };
  }
}
