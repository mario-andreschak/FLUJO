import { createHash } from 'node:crypto';
import type OpenAI from 'openai';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DecodedTool, ToolIdentityService } from './toolNamespace';
import { assertToolIdentityFresh } from './toolNamespace';
import type { NativeToolPort, NativeToolPortResult } from '@/backend/services/model/adapters/types';
import type { NativeInvocationReceipt } from './nativeToolJournal';
import { beginNativeTool, finishNativeTool, markNativeToolEffectMayHaveStarted, nativeToolFingerprint } from './nativeToolJournal';
import { applyPresetArguments } from '@/backend/utils/resolveDynamicReferences';
import { ownerScopeForRun } from '@/backend/services/mcp/ownerScope';
import { DEFAULT_TOOL_CALL_TIMEOUT_SECONDS } from '@/shared/types/mcp';
import { splitToolResultMedia } from '@/backend/services/runResources/toolResultMedia';
import { getRunResourceSettings } from '@/backend/services/runResources';
import { boundToolResult } from '@/backend/services/runResources/boundToolResult';
import { combineAbortSignals } from '../combineAbortSignals';

const ports = new WeakSet<object>();
const authorities = new WeakSet<object>();
const MAX_PORT_RESULT_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 64 * 1024;

export interface NativeBrokerAuthority {
  readonly leaseEpoch: string;
  readonly assertCurrent: () => Promise<void>;
}

/** A capability requires a live closure and cannot be reconstructed from JSON. */
export function createNativeBrokerAuthority(leaseEpoch: string, assertCurrent: () => Promise<void>): NativeBrokerAuthority {
  if (!leaseEpoch || typeof assertCurrent !== 'function') throw new Error('Native broker authority is incomplete.');
  const authority = Object.freeze({ leaseEpoch, assertCurrent });
  authorities.add(authority);
  return authority;
}

export function assertNativeBrokerAuthority(value: unknown): asserts value is NativeBrokerAuthority {
  if (!value || typeof value !== 'object' || !authorities.has(value)) {
    throw new Error('Native broker authority must be an in-process capability.');
  }
}

export function assertNativeToolPort(value: unknown): asserts value is NativeToolPort {
  if (!value || typeof value !== 'object' || !ports.has(value)) {
    throw new Error('Native tool port must be an origin-owned in-process capability.');
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
export const nativeDigest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const isHandoff = (name: string) => name === 'handoff' || name.startsWith('handoff_to_');
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function nativeToolInventoryDigest(
  tools: OpenAI.ChatCompletionFunctionTool[],
  toolNameMap?: Record<string, DecodedTool>,
  localToolExecutors?: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
): string {
  const names = new Set<string>();
  return nativeDigest(tools.filter(tool => tool.type === 'function').map(tool => {
    const name = tool.function.name;
    if (!name || names.has(name)) throw new Error('Native tool inventory has duplicate or empty names.');
    names.add(name);
    const decoded = toolNameMap?.[name];
    if (decoded && (decoded.clientGeneration === undefined || !decoded.schemaHash)) {
      throw new Error(`Native MCP tool ${name} lacks frozen client and schema identity.`);
    }
    const synthetic = Boolean(localToolExecutors?.[name]);
    const handoff = isHandoff(name);
    if (Number(Boolean(decoded)) + Number(synthetic) + Number(handoff) !== 1) {
      throw new Error(`Native tool ${name} has no unique Worker-owned executor.`);
    }
    return {
      name, description: tool.function.description ?? '', inputSchema: tool.function.parameters,
      annotations: decoded?.annotations, binding: decoded,
      kind: decoded ? 'mcp' : handoff ? 'handoff' : 'synthetic',
    };
  }));
}

type BrokerService = ToolIdentityService & Pick<typeof import('@/backend/services/mcp').mcpService, 'callTool'>;

export interface NativeBrokerInput {
  receipt: NativeInvocationReceipt;
  tools: OpenAI.ChatCompletionFunctionTool[];
  toolNameMap?: Record<string, DecodedTool>;
  localToolExecutors?: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  service: BrokerService;
  requestToolApproval?: (call: { id: string; name: string; args: Record<string, unknown> }) => Promise<boolean>;
  beforeToolDispatch?: () => Promise<void>;
  afterToolDispatch?: () => Promise<void>;
  authorizePersonaCoreMcp?: (serverName: string, nodeId?: string) => Promise<void>;
  authority: NativeBrokerAuthority;
  signal: AbortSignal;
}

/** Freeze exactly the tools on this provider attempt; retain executors only here. */
export function createNativeToolPort(input: NativeBrokerInput): NativeToolPort {
  assertNativeBrokerAuthority(input.authority);
  const advertised = structuredClone(input.tools.filter(tool => tool.type === 'function').map(tool => ({
    name: tool.function.name,
    description: tool.function.description ?? '',
    inputSchema: tool.function.parameters as Record<string, unknown> | undefined,
    annotations: input.toolNameMap?.[tool.function.name]?.annotations,
  })));
  const bound = structuredClone(input.toolNameMap ?? {});
  const executors = Object.freeze({ ...input.localToolExecutors });
  const names = new Set<string>();
  const kinds = new Map<string, 'mcp' | 'synthetic' | 'handoff'>();
  for (const tool of advertised) {
    if (!tool.name || names.has(tool.name)) throw new Error('Native tool inventory has duplicate or empty names.');
    names.add(tool.name);
    const kindsForName = [Boolean(bound[tool.name]), Boolean(executors[tool.name]), isHandoff(tool.name)]
      .filter(Boolean).length;
    if (kindsForName !== 1) throw new Error(`Native tool ${tool.name} has no unique Worker-owned executor.`);
    if (bound[tool.name] && (bound[tool.name].clientGeneration === undefined || !bound[tool.name].schemaHash)) {
      throw new Error(`Native MCP tool ${tool.name} lacks frozen client and schema identity.`);
    }
    kinds.set(tool.name, bound[tool.name] ? 'mcp' : isHandoff(tool.name) ? 'handoff' : 'synthetic');
  }
  const inventoryDigest = nativeToolInventoryDigest(input.tools, bound, executors);
  if (inventoryDigest !== input.receipt.owner.inventoryDigest
    || input.authority.leaseEpoch !== input.receipt.owner.leaseEpoch) {
    throw new Error('Native tool inventory or lease differs from the durable invocation.');
  }
  deepFreeze(advertised);
  deepFreeze(bound);
  const controller = new AbortController();
  const port: NativeToolPort = Object.freeze({
    invocationId: input.receipt.invocationId,
    inventoryDigest,
    advertised,
    cancel: () => controller.abort(),
    dispatch: async ({ toolInvocationId, name, args, signal }: Parameters<NativeToolPort['dispatch']>[0]): Promise<NativeToolPortResult> => {
      if (!names.has(name) || !args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('Native tool was not in the advertised inventory.');
      }
      // The SDK owns the callback object. Capture one JSON wire snapshot before
      // any journal or approval await and use it through the final effect.
      const argsJson = JSON.stringify(args);
      if (!argsJson) throw new Error('Native tool arguments must be a JSON object.');
      if (Buffer.byteLength(argsJson, 'utf8') > 256 * 1024) {
        throw new Error('Native tool arguments exceed the broker bound.');
      }
      const callArgs = deepFreeze(JSON.parse(argsJson) as Record<string, unknown>);
      if (!callArgs || typeof callArgs !== 'object' || Array.isArray(callArgs)) {
        throw new Error('Native tool arguments must be a JSON object.');
      }
      const fingerprint = nativeToolFingerprint(name, callArgs, inventoryDigest);
      const { entry, fresh } = await beginNativeTool(input.receipt, toolInvocationId, fingerprint);
      const combined = combineAbortSignals(input.signal, controller.signal, signal)!;
      if (!fresh) {
        if (entry.state === 'terminal' && entry.result) {
          combined.throwIfAborted();
          await input.authority.assertCurrent();
          combined.throwIfAborted();
          return entry.result;
        }
        throw new Error('Native tool effect is unresolved; the original call cannot be replayed.');
      }
      const assertCurrent = async () => {
        combined.throwIfAborted();
        await input.authority.assertCurrent();
        await input.beforeToolDispatch?.();
        combined.throwIfAborted();
        await input.authority.assertCurrent();
        combined.throwIfAborted();
      };
      const kind = kinds.get(name)!;
      await assertCurrent();
      const approved = await input.requestToolApproval?.({ id: toolInvocationId, name, args: callArgs });
      let result: CallToolResult;
      if (approved === false) {
        result = { content: [{ type: 'text', text: 'tool denied' }], isError: true };
      } else if (kind === 'handoff') {
        await assertCurrent();
        const schema = advertised.find(tool => tool.name === name)?.inputSchema;
        const spawnable = Boolean((schema as { properties?: Record<string, unknown> } | undefined)?.properties?.task);
        result = { content: [{ type: 'text', text: spawnable
          ? 'Worker spawned for this task. Call this tool again right now to spawn another parallel worker (one call per task). When you stop calling it, all spawned workers run concurrently and their merged results come back.'
          : 'Handing off.' }] };
      } else if (kind === 'synthetic') {
        await assertCurrent();
        await markNativeToolEffectMayHaveStarted(entry);
        await assertCurrent();
        const output = await executors[name](callArgs);
        await input.authority.assertCurrent();
        await input.afterToolDispatch?.();
        result = { content: [{ type: 'text', text: JSON.stringify(output) }] };
      } else {
        const decoded = bound[name];
        const effectiveArgs = await applyPresetArguments(callArgs, decoded.presetArgs, decoded.context);
        await assertCurrent();
        await input.authorizePersonaCoreMcp?.(decoded.server, decoded.nodeId);
        const freshness = assertToolIdentityFresh(name, decoded, input.service);
        const exactIdentity = Boolean(input.service.getClient(decoded.server))
          && input.service.getClientGeneration(decoded.server) === decoded.clientGeneration
          && input.service.getToolSchemaHash(decoded.server, decoded.tool) === decoded.schemaHash;
        if (!freshness.ok || !exactIdentity) {
          result = { content: [{ type: 'text', text: freshness.ok ? 'Native tool identity changed after advertisement.' : freshness.reason }], isError: true };
        } else {
          await markNativeToolEffectMayHaveStarted(entry);
          await assertCurrent();
          const finalIdentity = Boolean(input.service.getClient(decoded.server))
            && input.service.getClientGeneration(decoded.server) === decoded.clientGeneration
            && input.service.getToolSchemaHash(decoded.server, decoded.tool) === decoded.schemaHash;
          combined.throwIfAborted();
          if (!finalIdentity) throw new Error('Native MCP identity changed at the effect boundary.');
          const called = await input.service.callTool(
            decoded.server, decoded.tool, effectiveArgs,
            decoded.timeout ?? DEFAULT_TOOL_CALL_TIMEOUT_SECONDS,
            undefined, decoded.nodeId, combined, 'model',
            ownerScopeForRun({ runId: input.receipt.owner.runId, conversationId: input.receipt.owner.conversationId }),
            { conversationId: input.receipt.owner.conversationId },
          );
          await input.authority.assertCurrent();
          await input.afterToolDispatch?.();
          combined.throwIfAborted();
          // A transport failure or timeout cannot prove whether an effect ran.
          // Keep the durable effect-unknown marker and stop the original SDK.
          if (!called.success) throw new Error(`Native MCP effect is unresolved: ${called.error ?? 'Unknown error'}`);
          result = called.data as CallToolResult;
        }
      }
      const { mediaItems, textResult } = splitToolResultMedia(result);
      let transcriptText = JSON.stringify(textResult);
      if (kind === 'mcp') {
        const settings = await getRunResourceSettings();
        const bounded = await boundToolResult({
          conversationId: input.receipt.owner.conversationId,
          toolCallId: toolInvocationId,
          server: bound[name].server, toolName: bound[name].tool,
          nodeId: bound[name].nodeId, content: transcriptText, settings,
        });
        if (bounded.spilled) {
          transcriptText = bounded.content;
          result = { ...result, content: [...mediaItems, { type: 'text', text: transcriptText }] };
        }
      }
      // Configurable context bounds may be disabled. The broker's transport
      // boundary is fixed and never forwards an unbounded text/media payload.
      if (Buffer.byteLength(transcriptText, 'utf8') > MAX_TRANSCRIPT_BYTES
        || Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_PORT_RESULT_BYTES) {
        throw new Error('Native tool result exceeds the broker transport bound.');
      }
      await input.authority.assertCurrent();
      const terminal = { result, transcriptText, kind };
      await finishNativeTool(entry, terminal);
      combined.throwIfAborted();
      await input.authority.assertCurrent();
      combined.throwIfAborted();
      return terminal;
    },
  });
  ports.add(port);
  return port;
}
