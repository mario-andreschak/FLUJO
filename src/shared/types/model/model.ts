import { ModelProvider } from './provider';

export interface Model {
    id: string;
    name: string;
    displayName?: string;
    description?: string;
    ApiKey: string;
    baseUrl?: string;
    provider?: ModelProvider;
    promptTemplate?: string;
    // New fields
    reasoningSchema?: string;
    temperature?: string;
    functionCallingSchema?: string;
  }
