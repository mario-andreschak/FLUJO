import { ModelProvider } from './provider';

export interface Model {
    id: string;
    name: string;
    displayName?: string;
    description?: string;
    encryptedApiKey: string;
    baseUrl?: string;
    provider?: ModelProvider;
    promptTemplate?: string;
    // New fields
    reasoningSchema?: string;
    temperature?: string;
    functionCallingSchema?: string;
  }
