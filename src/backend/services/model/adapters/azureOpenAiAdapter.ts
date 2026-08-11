import OpenAI from 'openai';
import type { Model } from '@/shared/types/model';
import {
  AZURE_OPENAI_DEFAULT_API_VERSION,
  createAzureOpenAIClient,
} from '../openaiClient';
import { OpenAiAdapter } from './openaiAdapter';

/**
 * Azure OpenAI keeps the Chat Completions payload shape but changes routing and
 * authentication: requests are scoped to a deployment, carry `api-version`,
 * and authenticate through `api-key`. The AzureOpenAI SDK client owns those
 * differences while OpenAiAdapter continues to normalize messages, tools,
 * streaming, retries, usage, and media exactly like the regular OpenAI path.
 */
export class AzureOpenAiAdapter extends OpenAiAdapter {
  protected override createClient(model: Model, apiKey: string): OpenAI {
    const endpoint = model.baseUrl?.trim();
    if (!endpoint) throw new Error('Azure OpenAI endpoint is required');
    if (!model.name?.trim()) throw new Error('Azure OpenAI deployment name is required');

    return createAzureOpenAIClient({
      apiKey,
      endpoint,
      deployment: model.name.trim(),
      apiVersion: model.azureApiVersion?.trim() || AZURE_OPENAI_DEFAULT_API_VERSION,
    });
  }
}
