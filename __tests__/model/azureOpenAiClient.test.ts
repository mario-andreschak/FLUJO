import { AzureOpenAI } from 'openai';
import {
  AZURE_OPENAI_DEFAULT_API_VERSION,
  createAzureOpenAIClient,
} from '@/backend/services/model/openaiClient';

describe('createAzureOpenAIClient', () => {
  it('configures the Azure resource root, deployment, and default API version', () => {
    const client = createAzureOpenAIClient({
      apiKey: 'azure-key',
      endpoint: 'https://team.openai.azure.com/',
      deployment: 'production-gpt',
    });

    expect(client).toBeInstanceOf(AzureOpenAI);
    expect(client.baseURL).toBe('https://team.openai.azure.com/openai');
    expect(client.deploymentName).toBe('production-gpt');
    expect(client.apiVersion).toBe(AZURE_OPENAI_DEFAULT_API_VERSION);
  });
});
