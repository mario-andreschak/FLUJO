import { v4 as uuidv4 } from 'uuid';

import { Model } from '@/shared/types';

export type GuidedConnectionKind =
  | 'openrouter-free'
  | 'requesty-free'
  | 'openrouter-paid'
  | 'requesty-paid'
  | 'claude-subscription'
  | 'codex-subscription'
  | 'gemini-native'
  | 'ollama';

interface GuidedModelInput {
  kind: GuidedConnectionKind;
  apiKey?: string;
  ollamaModel?: string;
  ollamaUrl?: string;
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

const TEMPLATES: Record<Exclude<GuidedConnectionKind, 'ollama'>, ModelTemplate[]> = {
  'openrouter-free': [
    {
      name: 'openrouter/free',
      displayName: 'OpenRouter Free',
      description: 'Automatically routes each request to an available free OpenRouter model.',
      provider: 'openrouter',
      adapter: 'openai',
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
      adapter: 'openai',
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
      adapter: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      supportsTools: true,
    },
    {
      name: 'deepseek/deepseek-v3.2',
      displayName: 'DeepSeek V3.2',
      description: 'A cost-conscious model for fast general-purpose work.',
      provider: 'openrouter',
      adapter: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      supportsTools: true,
    },
    {
      name: 'openai/gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol via OpenRouter',
      description: 'A high-capability model for demanding agentic work.',
      provider: 'openrouter',
      adapter: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      reasoningEffort: 'medium',
      supportsTools: true,
    },
  ],
  'requesty-paid': [
    {
      name: 'deepseek/deepseek-v3.2',
      displayName: 'DeepSeek V3.2 via Requesty',
      description: 'A cost-conscious default routed through Requesty.',
      provider: 'requesty',
      adapter: 'openai',
      baseUrl: 'https://router.requesty.ai/v1',
      supportsTools: true,
    },
    {
      name: 'anthropic/claude-sonnet-4-6',
      displayName: 'Claude Sonnet via Requesty',
      description: 'A balanced model for planning, writing, and tool use.',
      provider: 'requesty',
      adapter: 'openai',
      baseUrl: 'https://router.requesty.ai/v1',
      supportsTools: true,
    },
    {
      name: 'openai/gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol via Requesty',
      description: 'A high-capability model for demanding agentic work.',
      provider: 'requesty',
      adapter: 'openai',
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
  'codex-subscription': [
    {
      name: 'gpt-5.6-terra',
      displayName: 'Codex Terra',
      description: 'A balanced Codex model for everyday agent work.',
      provider: 'codex',
      adapter: 'codex-cli',
      reasoningEffort: 'medium',
      supportsTools: true,
    },
    {
      name: 'gpt-5.6-sol',
      displayName: 'Codex Sol',
      description: 'The high-capability Codex model for difficult work.',
      provider: 'codex',
      adapter: 'codex-cli',
      reasoningEffort: 'high',
      supportsTools: true,
    },
    {
      name: 'gpt-5.4-mini',
      displayName: 'Codex Mini',
      description: 'A quick, efficient Codex option for smaller tasks.',
      provider: 'codex',
      adapter: 'codex-cli',
      reasoningEffort: 'medium',
      supportsTools: true,
    },
  ],
  'gemini-native': [
    {
      name: 'gemini-2.5-flash-lite',
      displayName: 'Gemini Flash Lite',
      description: 'A quick and economical native Gemini model.',
      provider: 'gemini',
      adapter: 'gemini',
      supportsTools: true,
    },
    {
      name: 'gemini-2.5-flash',
      displayName: 'Gemini Flash',
      description: 'A balanced native Gemini model for everyday work.',
      provider: 'gemini',
      adapter: 'gemini',
      supportsTools: true,
    },
    {
      name: 'gemini-2.5-pro',
      displayName: 'Gemini Pro',
      description: 'A stronger native Gemini model for complex work.',
      provider: 'gemini',
      adapter: 'gemini',
      supportsTools: true,
    },
  ],
};

/** Build the concrete FLUJO model records produced by a completed wizard path. */
export function buildGuidedModels(input: GuidedModelInput): Model[] {
  const apiKey = input.apiKey?.trim() ?? '';
  const templates: ModelTemplate[] = input.kind === 'ollama'
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
    promptTemplate: '',
    temperature: template.adapter === 'openai' || template.adapter === 'gemini' ? '0.0' : undefined,
    reasoningEffort: template.reasoningEffort,
    supportsTools: template.supportsTools,
  }));
}

export function guidedBundleNames(kind: GuidedConnectionKind): string[] {
  return buildGuidedModels({ kind }).map((model) => model.displayName || model.name);
}
