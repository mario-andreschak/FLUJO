import { v4 as uuidv4 } from 'uuid';

import { Model } from '@/shared/types';
import type { NormalizedModel } from '@/shared/types/model/response';
import {
  AZURE_OPENAI_DEFAULT_API_VERSION,
  ANTIGRAVITY_CLI_API_KEY_MODELS,
  ANTIGRAVITY_CLI_GUIDED_MODELS,
  getAntigravityCliModelLabel,
  GEMINI_NATIVE_GUIDED_MODELS,
  getProviderProfileById,
} from '@/shared/types/model/provider';

export type GuidedConnectionKind =
  | 'openrouter-free'
  | 'requesty-free'
  | 'openrouter-paid'
  | 'requesty-paid'
  | 'orcarouter-paid'
  | 'azure'
  | 'claude-subscription'
  | 'codex-subscription'
  | 'antigravity-cli'
  | 'gemini-native'
  | 'ollama';

interface GuidedModelInput {
  kind: GuidedConnectionKind;
  apiKey?: string;
  ollamaModel?: string;
  ollamaUrl?: string;
  azureEndpoint?: string;
  azureDeployment?: string;
  azureApiVersion?: string;
  codexModels?: NormalizedModel[];
}

interface ModelTemplate {
  name: string;
  displayName: string;
  description: string;
  provider: NonNullable<Model['provider']>;
  adapter: NonNullable<Model['adapter']>;
  baseUrl?: string;
  reasoningEffort?: Model['reasoningEffort'];
  supportsTools?: boolean;
}

const GEMINI_GUIDED_METADATA: Record<
  (typeof GEMINI_NATIVE_GUIDED_MODELS)[number],
  Pick<ModelTemplate, 'displayName' | 'description'>
> = {
  'gemini-3.5-flash-lite': {
    displayName: 'Gemini 3.5 Flash-Lite',
    description: 'A quick and economical native Gemini model.',
  },
  'gemini-3.8-flash': {
    displayName: 'Gemini 3.8 Flash',
    description: 'The newest stable native Gemini model for complex everyday work.',
  },
  'gemini-2.5-pro': {
    displayName: 'Gemini 2.5 Pro',
    description: 'A compatible Pro model for demanding reasoning tasks.',
  },
};

const TEMPLATES: Record<Exclude<GuidedConnectionKind, 'ollama' | 'azure'>, ModelTemplate[]> = {
  'openrouter-free': [
    {
      name: 'openrouter/free',
      displayName: 'OpenRouter Free',
      description: 'Automatically routes each request to an available free OpenRouter model.',
      provider: 'openrouter',
      adapter: 'openai-responses',
      baseUrl: 'https://openrouter.ai/api/v1',
      supportsTools: true,
    },
  ],
  'requesty-free': [
    {
      name: 'openrouter/free',
      displayName: 'Requesty Free Router',
      description: 'Routes to OpenRouter’s free-model router through your Requesty account.',
      provider: 'requesty',
      adapter: 'openai-responses',
      baseUrl: 'https://router.requesty.ai/v1',
      supportsTools: true,
    },
  ],
  'openrouter-paid': [
    {
      name: 'openrouter/auto',
      displayName: 'OpenRouter Auto',
      description: 'A balanced automatic router for everyday work.',
      provider: 'openrouter',
      adapter: 'openai-responses',
      baseUrl: 'https://openrouter.ai/api/v1',
      supportsTools: true,
    },
    {
      name: 'deepseek/deepseek-v3.2',
      displayName: 'DeepSeek V3.2',
      description: 'A cost-conscious model for fast general-purpose work.',
      provider: 'openrouter',
      adapter: 'openai-responses',
      baseUrl: 'https://openrouter.ai/api/v1',
      supportsTools: true,
    },
    {
      name: 'openai/gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol via OpenRouter',
      description: 'A high-capability model for demanding agentic work.',
      provider: 'openrouter',
      adapter: 'openai-responses',
      baseUrl: 'https://openrouter.ai/api/v1',
      reasoningEffort: 'medium',
      supportsTools: true,
    },
  ],
  'orcarouter-paid': [{
    name: 'anthropic/claude-sonnet-4',
    displayName: 'Claude Sonnet via OrcaRouter',
    description: 'A vendor/model connection through your OrcaRouter account.',
    provider: getProviderProfileById('orcarouter')!.provider,
    adapter: getProviderProfileById('orcarouter')!.adapter,
    baseUrl: getProviderProfileById('orcarouter')!.baseUrl,
    supportsTools: true,
  }],
  'requesty-paid': [
    {
      name: 'deepseek/deepseek-v3.2',
      displayName: 'DeepSeek V3.2 via Requesty',
      description: 'A cost-conscious default routed through Requesty.',
      provider: 'requesty',
      adapter: 'openai-responses',
      baseUrl: 'https://router.requesty.ai/v1',
      supportsTools: true,
    },
    {
      name: 'anthropic/claude-sonnet-4-6',
      displayName: 'Claude Sonnet via Requesty',
      description: 'A balanced model for planning, writing, and tool use.',
      provider: 'requesty',
      adapter: 'openai-responses',
      baseUrl: 'https://router.requesty.ai/v1',
      supportsTools: true,
    },
    {
      name: 'openai/gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol via Requesty',
      description: 'A high-capability model for demanding agentic work.',
      provider: 'requesty',
      adapter: 'openai-responses',
      baseUrl: 'https://router.requesty.ai/v1',
      reasoningEffort: 'medium',
      supportsTools: true,
    },
  ],
  'claude-subscription': [
    {
      name: 'haiku',
      displayName: 'Claude Haiku',
      description: 'Fast and light for small tasks through your Claude subscription.',
      provider: 'claude-subscription',
      adapter: 'claude-cli',
      supportsTools: true,
    },
    {
      name: 'sonnet',
      displayName: 'Claude Sonnet',
      description: 'The balanced everyday choice through your Claude subscription.',
      provider: 'claude-subscription',
      adapter: 'claude-cli',
      reasoningEffort: 'medium',
      supportsTools: true,
    },
    {
      name: 'opus',
      displayName: 'Claude Opus',
      description: 'The strongest Claude option for complex work.',
      provider: 'claude-subscription',
      adapter: 'claude-cli',
      reasoningEffort: 'high',
      supportsTools: true,
    },
    {
      name: 'fable',
      displayName: 'Claude Fable',
      description: 'An additional Claude subscription model for flexible routing.',
      provider: 'claude-subscription',
      adapter: 'claude-cli',
      reasoningEffort: 'medium',
      supportsTools: true,
    },
  ],
  'codex-subscription': [],
  'gemini-native': GEMINI_NATIVE_GUIDED_MODELS.map((name) => ({
    name,
    ...GEMINI_GUIDED_METADATA[name],
    provider: 'gemini' as const,
    adapter: 'gemini' as const,
    supportsTools: true,
  })),
  'antigravity-cli': ANTIGRAVITY_CLI_GUIDED_MODELS.map((name) => ({
    name,
    displayName: name === 'default' ? getAntigravityCliModelLabel(name) : `Antigravity ${getAntigravityCliModelLabel(name)}`,
    description: 'Uses the official Antigravity CLI with an Antigravity account login or a Gemini API key on this host. Model availability depends on the chosen authentication mode.',
    provider: 'antigravity-cli' as const,
    adapter: 'antigravity-cli' as const,
    supportsTools: true,
  })),
};

/** Build the concrete FLUJO model records produced by a completed wizard path. */
export function buildGuidedModels(input: GuidedModelInput): Model[] {
  const apiKey = input.apiKey?.trim() ?? '';
  const templates: ModelTemplate[] = input.kind === 'azure'
    ? [
        {
          name: input.azureDeployment?.trim() || 'azure-deployment',
          displayName: input.azureDeployment?.trim()
            ? `Azure ${input.azureDeployment.trim()}`
            : 'Azure OpenAI deployment',
          description: 'An Azure OpenAI deployment connected through the deployment-aware Azure SDK.',
          provider: 'azure',
          adapter: 'azure',
          baseUrl: input.azureEndpoint?.trim().replace(/\/+$/, '') || '',
          supportsTools: true,
        },
      ]
    : input.kind === 'ollama'
    ? [
        {
          name: input.ollamaModel?.trim() || 'llama3.2:3b',
          displayName: `Local ${input.ollamaModel?.trim() || 'Llama 3.2'}`,
          description: 'Runs privately on this machine through Ollama.',
          provider: 'ollama',
          adapter: 'openai',
          baseUrl: `${(input.ollamaUrl || 'http://localhost:11434').replace(/\/+$/, '')}/v1`,
          supportsTools: true,
        },
      ]
    : input.kind === 'codex-subscription'
      ? (input.codexModels ?? []).map(model => ({
          name: model.id, displayName: model.name, description: model.description ?? '',
          provider: 'codex' as const, adapter: 'codex-cli' as const,
        }))
    : input.kind === 'antigravity-cli' && apiKey
      ? TEMPLATES[input.kind].filter(template =>
        (ANTIGRAVITY_CLI_API_KEY_MODELS as readonly string[]).includes(template.name))
      : TEMPLATES[input.kind];

  return templates.map((template) => ({
    id: uuidv4(),
    name: template.name,
    displayName: template.displayName,
    description: template.description,
    ApiKey: input.kind === 'ollama' ? 'ollama' : apiKey,
    baseUrl: template.baseUrl || '',
    provider: template.provider,
    adapter: template.adapter,
    ...(input.kind === 'antigravity-cli'
      ? { inputModalities: ['text'], visionInputCapability: 'unsupported' as const }
      : {}),
    ...(input.kind === 'azure'
      ? { azureApiVersion: input.azureApiVersion?.trim() || AZURE_OPENAI_DEFAULT_API_VERSION }
      : {}),
    promptTemplate: '',
    temperature: template.adapter === 'openai' || template.adapter === 'azure' || template.adapter === 'gemini'
      ? '0.0'
      : undefined,
    reasoningEffort: template.reasoningEffort,
    supportsTools: template.supportsTools,
  }));
}

export function guidedBundleNames(kind: GuidedConnectionKind, apiKey?: string): string[] {
  return buildGuidedModels({ kind, apiKey }).map((model) => model.displayName || model.name);
}
