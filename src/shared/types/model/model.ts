import {
    GeminiThinkingLevel,
    ModelProvider,
    ModelAdapter,
    ModelReasoningEffort,
    ModelServiceTier,
} from './provider';

/**
 * System default upper bound on agentic turns for self-orchestrating adapters
 * (e.g. the Claude subscription / Agent SDK path). Used when neither the Process
 * node nor the bound model specifies a Max Turns value. Raised to 255 (issue
 * #399) so unattended agentic runs get a generous budget; it stays well above
 * the old hard-coded cap of 30 so existing flows never get a tighter limit.
 * Explicit per-node/per-model overrides always win over this fallback.
 */
export const DEFAULT_AGENTIC_MAX_TURNS = 255;

/**
 * Normalize a candidate max-output-tokens value to a positive integer, or
 * `undefined` when it is unset / non-positive / non-finite. Used to build the
 * `explicit request > per-model > adapter default` precedence chain in one
 * consistent place (mirrors the Model settings UI parsing). `0` (the wire
 * parser's "absent" sentinel) and negatives collapse to `undefined` so they
 * don't shadow a lower-precedence value.
 */
export function normalizeMaxTokens(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : undefined;
}

export interface Model {
    id: string;
    name: string;
    displayName?: string;
    description?: string;
    ApiKey: string;
    baseUrl?: string;
    /** Azure OpenAI data-plane API version (for example `2024-10-21`). */
    azureApiVersion?: string;
    provider?: ModelProvider;
    /**
     * Which completion adapter/SDK drives this model. Optional for backward
     * compatibility: models saved before this field existed are treated as
     * 'openai' (the OpenAI-compatible path), which is how they always behaved.
     */
    adapter?: ModelAdapter;
    promptTemplate?: string;
    // New fields
    reasoningSchema?: string;
    temperature?: string;
    /**
     * Provider-specific reasoning depth. Mapped to OpenAI `reasoning_effort`,
     * Anthropic/Claude `effort`, or Codex `modelReasoningEffort`.
     */
    reasoningEffort?: ModelReasoningEffort;
    /** Gemini 3+ qualitative thinking depth. */
    thinkingLevel?: GeminiThinkingLevel;
    /**
     * Gemini 2.5 thinking-token budget. -1 asks Gemini to choose dynamically;
     * 0 disables thinking where that model allows it.
     */
    thinkingBudget?: number;
    /** Codex processing tier (standard/default or priority/Fast). */
    serviceTier?: ModelServiceTier;
    functionCallingSchema?: string;
    /**
     * The model's context window in tokens (as advertised by the provider).
     * Optional metadata: when set, the chat shows a context-usage meter for
     * conversations whose active node runs this model (provider-reported
     * prompt tokens vs. this limit).
     */
    contextWindow?: number;
    /**
     * Capability metadata discovered from the provider's model catalogue.
     * `supportsTools` is intentionally optional: false means explicitly
     * unsupported, while undefined means the provider did not tell us.
     */
    supportsTools?: boolean;
    supportedParameters?: string[];
    inputModalities?: string[];
    outputModalities?: string[];
    /** Explicit tri-state image-input capability used by visual compaction. */
    visionInputCapability?: 'supported' | 'unsupported' | 'unknown';
    /**
     * Upper bound on agentic turns for self-orchestrating adapters (e.g. the
     * Claude subscription / Agent SDK path). A Process node can override this
     * per-node. Unset = the system default (DEFAULT_AGENTIC_MAX_TURNS = 255).
     */
    maxTurns?: number;
    /**
     * Optional per-model default upper bound on tokens the provider may generate
     * for a single completion. Precedence: an explicit request `max_tokens`
     * overrides this; when neither is set the adapter decides (OpenAI/Gemini send
     * no cap, Anthropic uses its documented 8192 fallback). Unset = no per-model
     * default.
     */
    maxTokens?: number;
    /**
     * Optional per-model override of the prompt-token figure at/above which
     * SUMMARIZING COMPACTION triggers pre-flight (issue #248). When unset the
     * trigger is derived from `contextWindow` minus the configured buffer.
     * Only consulted when the experimental `compactionEnabled` setting is on.
     */
    compactionThreshold?: number;
    /**
     * Optional, user-assigned folder for organizing model cards (#71). Absent/empty
     * means "Ungrouped". Frontend-only organization — has no effect on the model.
     */
    folder?: string;
    /**
     * Optional favorite flag (#146, mirrors flows #120). When true the model floats
     * to the top of the Models dashboard and of every model picker. Additive and
     * optional: absence reads as "not a favorite". Frontend-only organization —
     * has no effect on the model.
     */
    favorite?: boolean;
  }
