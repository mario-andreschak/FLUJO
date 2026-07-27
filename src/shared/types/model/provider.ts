/**
 * Supported model providers (the vendor / endpoint identity).
 */
export type ModelProvider =
  | 'openai'
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
  | 'gemini'
  | 'anthropic'
  | 'claude-cli'
  | 'codex-cli';

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
    showBaseUrl: false,
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
