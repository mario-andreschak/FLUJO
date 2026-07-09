/**
 * Tests for getProviderFromBaseUrl() and the LiteLLM URL recognition helper.
 *
 * getProviderFromBaseUrl maps a user-supplied base URL to the correct
 * ModelProvider. LiteLLM proxies typically run on :4000 or sit behind a
 * reverse-proxy at a /litellm path prefix, so the detection covers both.
 */
import {
  getProviderFromBaseUrl,
  isLitellmUrl,
} from '@/backend/services/model/provider';

describe('getProviderFromBaseUrl', () => {
  it.each([
    ['https://api.openai.com/v1', 'openai'],
    ['https://openrouter.ai/api/v1', 'openrouter'],
    ['https://api.x.ai/v1', 'xai'],
    ['https://generativelanguage.googleapis.com/v1beta/openai/', 'gemini'],
    ['https://api.anthropic.com/v1/', 'anthropic'],
    ['https://api.mistral.ai/v1', 'mistral'],
    ['http://localhost:11434/v1', 'ollama'],
  ])('recognises %s as %s', (url, expected) => {
    expect(getProviderFromBaseUrl(url)).toBe(expected);
  });

  it('recognises the default LiteLLM proxy URL', () => {
    expect(getProviderFromBaseUrl('http://localhost:4000/v1')).toBe('litellm');
  });

  it('recognises LiteLLM on 127.0.0.1:4000', () => {
    expect(getProviderFromBaseUrl('http://127.0.0.1:4000/v1')).toBe('litellm');
  });

  it('recognises LiteLLM on 0.0.0.0:4000', () => {
    expect(getProviderFromBaseUrl('http://0.0.0.0:4000/v1')).toBe('litellm');
  });

  it('recognises a remote LiteLLM proxy on port 4000', () => {
    expect(getProviderFromBaseUrl('https://my-litellm.example.com:4000/v1')).toBe('litellm');
  });

  it('recognises a reverse-proxied /litellm path', () => {
    expect(getProviderFromBaseUrl('https://gateway.corp.io/litellm/v1')).toBe('litellm');
  });

  it('falls back to ollama for an unknown local URL', () => {
    expect(getProviderFromBaseUrl('http://localhost:8080/v1')).toBe('ollama');
  });
});

describe('isLitellmUrl', () => {
  it('returns true for localhost:4000', () => {
    expect(isLitellmUrl('http://localhost:4000')).toBe(true);
    expect(isLitellmUrl('http://localhost:4000/v1')).toBe(true);
  });

  it('returns true for a /litellm path segment', () => {
    expect(isLitellmUrl('https://api.corp.io/litellm/v1')).toBe(true);
  });

  it('is case-insensitive on the path segment', () => {
    expect(isLitellmUrl('https://api.corp.io/LiteLLM/v1')).toBe(true);
  });

  it('returns false for unrelated URLs', () => {
    expect(isLitellmUrl('https://api.openai.com/v1')).toBe(false);
    expect(isLitellmUrl('http://localhost:11434/v1')).toBe(false);
  });

  it('tolerates malformed URLs via string fallback', () => {
    // Strings that cannot be parsed by new URL() fall back to substring checks.
    expect(isLitellmUrl(':4000/v1')).toBe(true);
    expect(isLitellmUrl('bad://url/litellm')).toBe(true);
  });
});
