export interface Model {
    id: string;
    name: string;
    displayName?: string;
    description?: string;
    encryptedApiKey: string;
    baseUrl?: string;
    promptTemplate?: string;
    // New fields
    reasoningSchema?: string;
    temperature?: string;
    functionCallingSchema?: string;
  }