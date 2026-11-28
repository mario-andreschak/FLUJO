// The contract of one provider completion, shared by ModelHandler and the modules it hands work to.
import { ModelCallInput, ModelCallResult } from '../types/modelHandler';
import { FlujoChatMessage } from '@/shared/types/chat';
import { Result } from '../errors';
import { type DecodedTool } from './toolNamespace';
import { type NativeBrokerAuthority } from './nativeToolBroker';
import { type NativeInvocationSessionHook } from './nativeInvocationSession';
import { type NativeOriginalProcessHost } from './nativeOriginalHost';
import OpenAI from 'openai';
import { type ModelCatalogAdmission } from '@/backend/services/model/catalogAdmission';
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import type { ModelSteering, ModelStreamDelta, ModelToolProgress, ToolResourceMarker } from '@/backend/services/model/adapters/types';
import type { RecoveryFailureDetails } from '@/shared/types/execution/events';
import { type FlowDurableMutationContext } from '@/backend/execution/flow/executionAuthority';

/** Options for one provider completion (ModelHandler.generateCompletion). */
export type GenerateCompletionOptions = {
  modelCatalogAdmission?: ModelCatalogAdmission;
  toolNameMap?: Record<string, DecodedTool>;
  maxTurns?: number;
  /** Effective per-completion output-token cap, already resolved by callModel
   *  (node override → model setting). Undefined ⇒ adapter default (#189). */
  maxTokens?: number;
  /** Internal structured replies, forwarded only to adapters supporting them. */
  outputSchema?: Record<string, unknown>;
  /** A provider-side summary of exactly these messages instead of a reply (#1091). */
  nativeCompaction?: CompletionInput['nativeCompaction'];
  temperatureOverride?: number;
  requestToolApproval?: (call: {
    id: string;
    name: string;
    args: Record<string, unknown>;
  }) => Promise<boolean>;
  onTranscriptMessage?: (message: FlujoChatMessage) => void;
  consumeSteeringMessages?: () => FlujoChatMessage[];
  steering?: ModelSteering;
  onModelDelta?: (delta: ModelStreamDelta) => void;
  onToolProgress?: (progress: ModelToolProgress) => void;
  /** Polled while the provider call is in flight; true aborts it (Stop). */
  shouldAbort?: () => boolean;
  /** Conversation + node identity, so self-orchestrating adapters can key a
   * reusable Agent SDK session per (conversationId, nodeId) — issue #154. */
  conversationId?: string;
  runId?: string;
  nodeId?: string;
  /** One-use ordinal from the active Process execution, not request metadata. */
  takeModelStepOrdinal?: () => number;
  codexSession?: import('../types').CodexSessionMetadata;
  onCodexSessionChange?: (session: import('../types').CodexSessionMetadata | undefined) => void;
  responsesSession?: import('@/backend/services/model/adapters/responsesSessionState').ResponsesSessionState;
  onResponsesSessionChange?: (session: import('@/backend/services/model/adapters/responsesSessionState').ResponsesSessionState | undefined) => void;
  /** Executors for caller-defined virtual tools (e.g. write_resource, issue
   * #161) run in-loop by self-orchestrating adapters. */
  localToolExecutors?: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  /** End a self-orchestrated provider loop successfully at its next safe
   * boundary. Meeting silence uses this to make the current round terminal. */
  shouldEndAgenticTurn?: () => boolean;
  /** Captured run resources for oversized prior tool results/args, keyed by
   * the producing tool_call_id; used by self-orchestrating adapters for
   * resource-aware truncation markers (issue #168). */
  runResourceMarkers?: Map<string, ToolResourceMarker>;
  /** #1226: the step's own tool result size limit and where moved results are kept. */
  toolResults?: CompletionInput['toolResults'];
  /** #154: opt-in to Agent SDK session reuse (resume + delta) for the Claude
   * subscription adapter. Resolved by callModel from the experimental setting
   * and node eligibility. */
  sessionResume?: boolean;
  systemPromptPolicy?: 'stable' | 'per-turn';
  onSessionEvent?: CompletionInput['onSessionEvent'];
  onFinalWire?: ModelCallInput['onFinalWire'];
  archiveModelTurns?: boolean;
  canonicalMessages?: FlujoChatMessage[];
  modelInputForArchive?: import('../types').ModelInputSnapshot;
  /** Message identities aligned with `messages` before provider shaping. */
  wireMessageIds?: Array<string | undefined>;
  nodeName?: string;
  /** Issue #400: called when a bounded session/rate limit is about to be
   *  waited out and retried. callModel projects this onto the existing
   *  `recovery:retry` execution event so the chat can show a countdown
   *  while the run stays alive and cancellable. */
  onRecoveryRetry?: (info: {
    attempt: number;
    retryAt: number;
    maxAttempts: number;
    failure: RecoveryFailureDetails;
  }) => void;
  /** Runtime-only Persona/activity fence assertion before tool side effects. */
  beforeToolDispatch?: () => Promise<void>;
  executionExtensionContext?: import('@/backend/execution/extensions').ExecutionExtensionContext;
  nativeBrokerAuthority?: NativeBrokerAuthority;
  nativeInvocationSessionHook?: NativeInvocationSessionHook;
  nativeOriginalProcessHost?: NativeOriginalProcessHost;
  /** Call-time authorization for Persona Core-injected MCP handles. */
  authorizePersonaCoreMcp?: (serverName: string, nodeId?: string) => Promise<void>;
  /** Runtime-only fence assertion immediately before every provider attempt. */
  beforeModelDispatch?: () => Promise<void>;
  /** Called with each fallback policy member as it is tried. */
  onModelRouted?: (modelId: string) => void;
  /** Authority context for resource/lineage writes performed in this call. */
  durableContext?: FlowDurableMutationContext;
  /** Drain authority-gated self-orchestrating transcript callbacks. */
  flushTranscriptProjection?: () => Promise<void>;
};

/** One provider completion, for modules that receive generateCompletion as a parameter. */
export type GenerateCompletion = (
  modelId: string,
  prompt: string,
  messages: FlujoChatMessage[],
  tools?: OpenAI.ChatCompletionFunctionTool[],
  opts?: GenerateCompletionOptions,
) => Promise<Result<ModelCallResult>>;
