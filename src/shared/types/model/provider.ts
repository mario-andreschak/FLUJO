/**
 * Supported model providers (the vendor / endpoint identity).
 */
export type ModelProvider =
  | 'openai'
  | 'azure'
  | 'openrouter'
  | 'requesty'
  | 'anthropic'
  | 'gemini'
  | 'mistral'
  | 'xai'
  | 'ollama'
  | 'litellm'
  | 'claude-subscription'
  | 'codex';

/** Stable Azure OpenAI data-plane API version used for new connections. */
export const AZURE_OPENAI_DEFAULT_API_VERSION = '2024-10-21';

/**
 * Which backend completion adapter (and SDK) drives a model.
 *
 * - 'openai'     -> OpenAiAdapter, the OpenAI-compatible HTTP path (Chat
 *                   Completions) used by every classic provider and by the
 *                   "OpenAI Format" variants of Gemini / Anthropic.
 * - 'openai-responses' -> OpenAiResponsesAdapter, OpenAI's Responses API. Same
 *                   stateless request/response contract as 'openai' (FLUJO keeps
 *                   owning the history — no previous_response_id), but carries
 *                   encrypted REASONING items across turns, so a gpt-5 / o-series
 *                   model in an agentic tool loop stops re-deriving its own
 *                   reasoning each iteration. Only worthwhile for reasoning
 *                   models; 'openai' remains the default everywhere else.
 * - 'azure'      -> AzureOpenAiAdapter, Azure OpenAI's deployment-scoped Chat
 *                   Completions API through the AzureOpenAI SDK client.
 * - 'gemini'     -> GeminiAdapter, native Google GenAI SDK.
 * - 'anthropic'  -> AnthropicAdapter, native Anthropic SDK.
 * - 'claude-cli' -> ClaudeSubscriptionAdapter, drives the `claude` CLI against a
 *                   Claude Pro/Max subscription (OAuth token in the API Key field).
 * - 'codex-cli'  -> CodexAdapter, drives the `codex` CLI through the Codex SDK
 *                   against a ChatGPT plan (`codex login`) or an OpenAI API key.
 */
export type ModelAdapter =
  | 'openai'
  | 'openai-responses'
  | 'azure'
  | 'gemini'
  | 'anthropic'
  | 'claude-cli'
  | 'codex-cli';

/** Provider-neutral reasoning effort stored on a configured model. */
export type ModelReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';

/** Gemini's qualitative thinking control (Gemini 3+). */
export type GeminiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

/** Processing tier exposed by the Codex runtime. */
export type ModelServiceTier = 'default' | 'priority';

export interface ModelConfigurationCapabilities {
  /** Temperature, presented to users as Creativity. */
  creativity?: { min: number; max: number; step: number };
  /** Provider-supported qualitative reasoning values. */
  effortLevels?: ModelReasoningEffort[];
  /** Gemini 3+ qualitative thinking levels. */
  thinkingLevels?: GeminiThinkingLevel[];
  /** Gemini 2.5 token-budget thinking control. */
  thinkingBudget?: boolean;
  /** Codex fast/priority processing tier. */
  priority?: boolean;
  /** Whether a single-call output-token cap reaches the selected adapter. */
  maxOutputTokens: boolean;
}

/**
 * Validate optional generation settings before they are persisted. This keeps
 * direct API callers and hand-authored payloads within the same capability
 * contract as the configuration modal.
 */
export function validateModelConfiguration(
  model: {
    provider?: ModelProvider;
    adapter?: ModelAdapter;
    name?: string;
    baseUrl?: string;
    azureApiVersion?: string;
    temperature?: unknown;
    reasoningEffort?: unknown;
    thinkingLevel?: unknown;
    thinkingBudget?: unknown;
    serviceTier?: unknown;
  }
): string | undefined {
  if (model.adapter === 'azure' || model.provider === 'azure') {
    if (!model.name?.trim()) return 'Azure OpenAI deployment name is required';
    const endpoint = model.baseUrl?.trim();
    if (!endpoint) return 'Azure OpenAI endpoint is required';
    try {
      const parsed = new URL(endpoint);
      if (parsed.protocol !== 'https:') return 'Azure OpenAI endpoint must use HTTPS';
    } catch {
      return 'Azure OpenAI endpoint must be a valid URL';
    }
    if (!model.azureApiVersion?.trim()) return 'Azure OpenAI API version is required';
  }

  const capabilities = getModelConfigurationCapabilities(model.provider, model.adapter, model.name ?? '');

  if (model.temperature !== undefined && model.temperature !== '') {
    const temperature = typeof model.temperature === 'number'
      ? model.temperature
      : typeof model.temperature === 'string' ? Number(model.temperature) : NaN;
    if (!capabilities.creativity || !Number.isFinite(temperature) ||
      temperature < capabilities.creativity.min || temperature > capabilities.creativity.max) {
      return capabilities.creativity
        ? `Creativity must be between ${capabilities.creativity.min} and ${capabilities.creativity.max}`
        : 'Creativity is not supported by this model';
    }
  }

  if (model.reasoningEffort !== undefined && model.reasoningEffort !== '') {
    if (!capabilities.effortLevels?.includes(model.reasoningEffort as ModelReasoningEffort)) {
      return 'The selected reasoning effort is not supported by this model';
    }
  }
  if (model.thinkingLevel !== undefined && model.thinkingLevel !== '') {
    if (!capabilities.thinkingLevels?.includes(model.thinkingLevel as GeminiThinkingLevel)) {
      return 'The selected thinking level is not supported by this model';
    }
  }
  if (model.thinkingBudget !== undefined && model.thinkingBudget !== '') {
    if (!capabilities.thinkingBudget || typeof model.thinkingBudget !== 'number' ||
      !Number.isInteger(model.thinkingBudget) || model.thinkingBudget < -1) {
      return 'Thinking budget must be an integer greater than or equal to -1 for this model';
    }
  }
  if (model.serviceTier !== undefined && model.serviceTier !== '') {
    if (!capabilities.priority ||
      (model.serviceTier !== 'default' && model.serviceTier !== 'priority')) {
      return 'The selected service tier is not supported by this model';
    }
  }

  return undefined;
}

/**
 * Parse a persisted creativity value for the execution path. Invalid values
 * are omitted rather than allowing NaN or an out-of-range value into a SDK.
 */
export function normalizeModelTemperature(
  value: unknown,
  provider?: ModelProvider,
  adapter?: ModelAdapter,
  modelName = ''
): number | undefined {
  const capabilities = getModelConfigurationCapabilities(provider, adapter, modelName);
  if (!capabilities.creativity || value === undefined || value === '') return undefined;
  const temperature = typeof value === 'number'
    ? value
    : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(temperature)) return undefined;
  return Math.min(capabilities.creativity.max, Math.max(capabilities.creativity.min, temperature));
}

const OPENAI_REASONING_MODEL = /(^|[/_-])(o[1-9]|gpt-5)(?:[./_-]|$)/i;
const ANTHROPIC_ADAPTIVE_MODEL =
  /claude-(?:fable|mythos)-5|claude-opus-4-(?:[7-9]|\d{2,})|claude-sonnet-5/i;
const ANTHROPIC_EFFORT_MODEL =
  /^(?:opus|sonnet|fable)$|claude-(?:fable|mythos)-5|claude-opus-4-(?:[6-9]|\d{2,})|claude-sonnet-4-6/i;

/**
 * Resolve the controls that have a real request/runtime mapping for a selected
 * provider profile and technical model name. Unknown OpenAI-compatible
 * endpoints deliberately get only Creativity: vendor-specific reasoning fields
 * are not portable across those proxies.
 */
export function getModelConfigurationCapabilities(
  provider?: ModelProvider,
  adapter?: ModelAdapter,
  modelName = ''
): ModelConfigurationCapabilities {
  const resolvedAdapter = adapter || 'openai';
  const resolvedProvider = provider || 'openai';
  const name = modelName.trim();

  if (resolvedAdapter === 'codex-cli') {
    const effortLevels: ModelReasoningEffort[] =
      /^gpt-5\.6-(?:sol|terra)$/i.test(name)
        ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
        : /^gpt-5\.6-/i.test(name)
          ? ['low', 'medium', 'high', 'xhigh', 'max']
          : ['low', 'medium', 'high', 'xhigh'];
    return {
      effortLevels,
      // Current mini/spark/review catalog entries do not advertise Fast mode.
      priority: !/(?:mini|spark|review)/i.test(name),
      maxOutputTokens: false,
    };
  }

  if (resolvedAdapter === 'claude-cli') {
    return {
      ...(ANTHROPIC_EFFORT_MODEL.test(name)
        ? { effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as ModelReasoningEffort[] }
        : {}),
      maxOutputTokens: false,
    };
  }

  if (resolvedAdapter === 'anthropic') {
    return {
      ...(!ANTHROPIC_ADAPTIVE_MODEL.test(name)
        ? { creativity: { min: 0, max: 1, step: 0.1 } }
        : {}),
      ...(ANTHROPIC_EFFORT_MODEL.test(name)
        ? { effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as ModelReasoningEffort[] }
        : {}),
      maxOutputTokens: true,
    };
  }

  if (resolvedAdapter === 'gemini') {
    return {
      creativity: { min: 0, max: 2, step: 0.1 },
      ...(/^gemini-2\.5/i.test(name)
        ? { thinkingBudget: true }
        : !/^gemini-2\.0/i.test(name)
          ? { thinkingLevels: ['minimal', 'low', 'medium', 'high'] as GeminiThinkingLevel[] }
          : {}),
      maxOutputTokens: true,
    };
  }

  const isOpenAIReasoningModel =
    resolvedProvider === 'openai' && OPENAI_REASONING_MODEL.test(name);
  return {
    ...(!isOpenAIReasoningModel
      ? { creativity: { min: 0, max: 2, step: 0.1 } }
      : {}),
    ...(isOpenAIReasoningModel
      ? { effortLevels: ['low', 'medium', 'high'] as ModelReasoningEffort[] }
      : {}),
    maxOutputTokens: true,
  };
}

/**
 * Adapters that run their OWN agentic tool loop inside a single
 * `createCompletion` call (Claude subscription / Codex), instead of the
 * request/response contract where FLUJO drives the loop. These adapters flatten
 * the wire themselves, manage their own truncation markers, and return a
 * `transcript` — so ModelHandler skips its wire-side compaction/refit for them.
 */
export function isSelfOrchestratingAdapter(adapter?: string): boolean {
  return adapter === 'claude-cli' || adapter === 'codex-cli';
}

/**
 * Provider information mapping
 */
export interface ProviderInfo {
  id: ModelProvider;
  label: string;
  baseUrl: string;
}

/**
 * Map of providers with their display labels and base URLs
 */
export const PROVIDER_INFO: Record<ModelProvider, Omit<ProviderInfo, 'id'>> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1'
  },
  azure: {
    label: 'Azure OpenAI',
    baseUrl: ''
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1'
  },
  requesty: {
    label: 'Requesty',
    baseUrl: 'https://router.requesty.ai/v1'
  },
  xai: {
    label: 'X.ai',
    baseUrl: 'https://api.x.ai/v1'
  },
  gemini: {
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/'
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1/'
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1'
  },
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1'
  },
  litellm: {
    label: 'LiteLLM',
    baseUrl: 'http://localhost:4000/v1'
  },
  'claude-subscription': {
    label: 'Claude Subscription',
    baseUrl: ''
  },
  codex: {
    label: 'Codex (OpenAI)',
    baseUrl: ''
  }
};

/**
 * Helper function to get all providers as an array
 */
export function getProvidersArray(): ProviderInfo[] {
  return Object.entries(PROVIDER_INFO).map(([id, info]) => ({
    id: id as ModelProvider,
    ...info
  }));
}

/**
 * A selectable entry in the model modal's "Provider" dropdown.
 *
 * A profile pins down BOTH the vendor (`provider`) and the SDK/adapter that
 * drives it (`adapter`). The same vendor can appear under more than one profile
 * — e.g. Gemini is offered both as "OpenAI Format" (adapter 'openai') and
 * "Native" (adapter 'gemini') — so the user explicitly chooses the integration
 * path rather than it being inferred from the base URL.
 */
export interface ProviderProfile {
  /** Stable id used as the dropdown's value. */
  id: string;
  /** Human-readable dropdown label. */
  label: string;
  provider: ModelProvider;
  adapter: ModelAdapter;
  /** Informational SDK name shown to the user (e.g. "OpenAI SDK", "Claude CLI"). */
  sdkLabel: string;
  /** Default base URL to prefill (empty when the adapter has no HTTP base URL). */
  baseUrl: string;
  /** Whether the Base URL field is shown/editable for this profile. */
  showBaseUrl: boolean;
  /** Whether the inference endpoint exposes an OpenAI-compatible model list. */
  supportsModelDiscovery?: boolean;
  /** Default Azure API version persisted when this profile is selected. */
  defaultApiVersion?: string;
  /**
   * Suggested model names for the technical-name autocomplete. Used for native
   * providers that have no reachable OpenAI `/models` endpoint. The field stays
   * free-text, so these are hints, not a closed list.
   */
  defaultModels?: string[];
}

/**
 * The set of provider profiles offered in the UI, in display order.
 * Mistral is intentionally omitted (hidden from the model modal).
 */
export const PROVIDER_PROFILES: ProviderProfile[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai',
    adapter: 'openai',
    sdkLabel: 'OpenAI SDK',
    baseUrl: 'https://api.openai.com/v1',
    showBaseUrl: true,
  },
  {
    id: 'openai-responses',
    label: 'OpenAI (Responses API)',
    provider: 'openai',
    adapter: 'openai-responses',
    sdkLabel: 'OpenAI SDK (Responses)',
    baseUrl: 'https://api.openai.com/v1',
    showBaseUrl: true,
    // Worth choosing only for reasoning models — the adapter's reason to exist is
    // carrying encrypted reasoning items across turns of an agentic tool loop.
    // Non-reasoning models should stay on the plain 'OpenAI' profile.
    defaultModels: ['gpt-5', 'gpt-5-mini', 'o4-mini', 'o3'],
  },
  {
    id: 'azure',
    label: 'Azure OpenAI',
    provider: 'azure',
    adapter: 'azure',
    sdkLabel: 'AzureOpenAI SDK',
    baseUrl: '',
    showBaseUrl: true,
    supportsModelDiscovery: false,
    defaultApiVersion: AZURE_OPENAI_DEFAULT_API_VERSION,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    provider: 'openrouter',
    adapter: 'openai',
    sdkLabel: 'OpenAI SDK',
    baseUrl: 'https://openrouter.ai/api/v1',
    showBaseUrl: true,
  },
  {
    id: 'requesty',
    label: 'Requesty',
    provider: 'requesty',
    adapter: 'openai',
    sdkLabel: 'OpenAI SDK',
    baseUrl: 'https://router.requesty.ai/v1',
    showBaseUrl: true,
    // Requesty routing policies are addressed like models: set the technical
    // name to `policy/<policy-name>` and the router applies that policy's
    // fallback chain. Policies also appear in Requesty's /v1/models listing,
    // so the autocomplete surfaces them automatically.
  },
  {
    id: 'xai',
    label: 'X.ai',
    provider: 'xai',
    adapter: 'openai',
    sdkLabel: 'OpenAI SDK',
    baseUrl: 'https://api.x.ai/v1',
    showBaseUrl: true,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    provider: 'ollama',
    adapter: 'openai',
    sdkLabel: 'OpenAI SDK',
    baseUrl: 'http://localhost:11434/v1',
    showBaseUrl: true,
  },
  {
    id: 'litellm',
    label: 'LiteLLM',
    provider: 'litellm',
    adapter: 'openai',
    sdkLabel: 'OpenAI SDK (via LiteLLM Proxy)',
    baseUrl: 'http://localhost:4000/v1',
    showBaseUrl: true,
  },
  {
    id: 'gemini-openai',
    label: 'Gemini (OpenAI Format)',
    provider: 'gemini',
    adapter: 'openai',
    sdkLabel: 'OpenAI SDK',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    showBaseUrl: true,
  },
  {
    id: 'gemini-native',
    label: 'Gemini (Native)',
    provider: 'gemini',
    adapter: 'gemini',
    sdkLabel: 'GenAI SDK',
    baseUrl: '',
    showBaseUrl: false,
    defaultModels: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
    ],
  },
  {
    id: 'anthropic-openai',
    label: 'Anthropic (OpenAI Format)',
    provider: 'anthropic',
    adapter: 'openai',
    sdkLabel: 'OpenAI SDK',
    baseUrl: 'https://api.anthropic.com/v1/',
    showBaseUrl: true,
  },
  {
    id: 'anthropic-native',
    label: 'Anthropic (Native)',
    provider: 'anthropic',
    adapter: 'anthropic',
    sdkLabel: 'Anthropic SDK',
    baseUrl: '',
    // The native SDK defaults to api.anthropic.com when this is blank, but it
    // also supports Anthropic-compatible endpoints such as Microsoft Foundry.
    // Keep the field editable so a custom URL loaded from models.json is not a
    // runtime-only setting that the connection modal cannot maintain.
    showBaseUrl: true,
    // Native Anthropic endpoints do not expose the OpenAI-compatible /models
    // discovery route used by the modal. Foundry also omits the Models API.
    supportsModelDiscovery: false,
    defaultModels: [
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
      'claude-fable-5',
    ],
  },
  {
    id: 'claude-subscription',
    label: 'Claude Subscription',
    provider: 'claude-subscription',
    adapter: 'claude-cli',
    sdkLabel: 'Claude CLI',
    baseUrl: '',
    showBaseUrl: false,
    // The Agent SDK accepts model aliases as well as full ids.
    defaultModels: ['opus', 'sonnet', 'haiku', 'fable'],
  },
  {
    id: 'codex',
    label: 'Codex (OpenAI)',
    provider: 'codex',
    adapter: 'codex-cli',
    sdkLabel: 'Codex SDK',
    baseUrl: '',
    showBaseUrl: false,
    // Hints only — the field stays free-text. Keep this aligned with the
    // user-facing catalog bundled by the supported Codex CLI.
    defaultModels: [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ],
  },
];

/** Resolve the profile that best matches a stored model's provider + adapter. */
export function getProviderProfile(
  provider?: ModelProvider,
  adapter?: ModelAdapter
): ProviderProfile {
  const wantProvider = provider || 'openai';
  const wantAdapter = adapter || 'openai';
  return (
    PROVIDER_PROFILES.find(p => p.provider === wantProvider && p.adapter === wantAdapter) ||
    PROVIDER_PROFILES.find(p => p.provider === wantProvider) ||
    PROVIDER_PROFILES[0]
  );
}

/** Look up a profile by its dropdown id. */
export function getProviderProfileById(id: string): ProviderProfile | undefined {
  return PROVIDER_PROFILES.find(p => p.id === id);
}
