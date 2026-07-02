import { ModelProvider, ModelAdapter } from './provider';

export interface Model {
    id: string;
    name: string;
    displayName?: string;
    description?: string;
    ApiKey: string;
    baseUrl?: string;
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
    functionCallingSchema?: string;
    /**
     * The model's context window in tokens (as advertised by the provider).
     * Optional metadata: when set, the chat shows a context-usage meter for
     * conversations whose active node runs this model (provider-reported
     * prompt tokens vs. this limit).
     */
    contextWindow?: number;
  }
