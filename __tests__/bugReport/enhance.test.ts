/**
 * Unit tests for the backend bug-report enhancement service (issue #127).
 *
 * The model layer is mocked so we can assert: validation, model resolution, defensive
 * JSON parsing, label allowlisting, context sanitization, and the fail-soft behaviour
 * (original text returned on any model failure).
 */

const getModelMock = jest.fn();
const generateChatCompletionMock = jest.fn();
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: (...a: unknown[]) => getModelMock(...a),
    generateChatCompletion: (...a: unknown[]) => generateChatCompletionMock(...a),
  },
}));

import {
  enhanceBugReport,
  sanitizeBugContext,
  filterLabels,
  parseEnhancement,
} from '@/backend/services/bugReport/enhance';

const completionWith = (content: string) => ({
  success: true,
  completion: { choices: [{ message: { content } }] },
});

beforeEach(() => {
  jest.clearAllMocks();
  getModelMock.mockResolvedValue({ id: 'm1', name: 'gpt-4o', displayName: 'GPT-4o' });
});

describe('sanitizeBugContext', () => {
  it('rebuilds from allowlisted keys only, dropping secret-shaped fields', () => {
    const ctx = sanitizeBugContext({
      appVersion: '3.21.0',
      installMode: 'git',
      os: 'Windows',
      browser: 'Chrome',
      mcpServerNames: ['a', 'b', 5],
      pageUrl: '/chat#thread',
      timestamp: '2026-07-17T18:00:00.000Z',
      apiKey: 'sk-SECRET',
      env: { TOKEN: 'shh' },
    });
    expect(ctx).toEqual({
      appVersion: '3.21.0',
      installMode: 'git',
      os: 'Windows',
      browser: 'Chrome',
      mcpServerNames: ['a', 'b'],
      pageUrl: '/chat#thread',
      timestamp: '2026-07-17T18:00:00.000Z',
    });
    expect(JSON.stringify(ctx)).not.toContain('sk-SECRET');
    expect(JSON.stringify(ctx)).not.toContain('shh');
  });

  it('coerces missing/garbage input to safe defaults', () => {
    expect(sanitizeBugContext(null)).toEqual({
      appVersion: 'unknown',
      installMode: 'unknown',
      os: 'unknown',
      browser: 'unknown',
      mcpServerNames: [],
      pageUrl: 'unknown',
      timestamp: 'unknown',
    });
  });
});

describe('filterLabels', () => {
  it('keeps only allowlisted labels', () => {
    expect(filterLabels(['bug', 'frontend', 'nonsense', 'security'])).toEqual(['bug', 'frontend']);
  });
  it('defaults to ["bug"] when nothing valid', () => {
    expect(filterLabels(['nope'])).toEqual(['bug']);
    expect(filterLabels('not-an-array')).toEqual(['bug']);
  });
});

describe('parseEnhancement', () => {
  it('parses plain JSON', () => {
    expect(parseEnhancement('{"title":"T","body":"B"}')).toEqual({ title: 'T', body: 'B' });
  });
  it('strips ```json fences', () => {
    expect(parseEnhancement('```json\n{"body":"B"}\n```')).toEqual({ body: 'B' });
  });
  it('returns null on non-JSON', () => {
    expect(parseEnhancement('sorry, I cannot')).toBeNull();
  });
});

describe('enhanceBugReport', () => {
  it('400s when modelId is missing (no model call)', async () => {
    const res = await enhanceBugReport({ modelId: '', title: 't', description: 'something broke' });
    expect(res).toMatchObject({ success: false, statusCode: 400 });
    expect(getModelMock).not.toHaveBeenCalled();
  });

  it('400s when description is missing', async () => {
    const res = await enhanceBugReport({ modelId: 'm1', title: 't', description: '   ' });
    expect(res).toMatchObject({ success: false, statusCode: 400 });
  });

  it('404s when the model cannot be resolved', async () => {
    getModelMock.mockResolvedValue(null);
    const res = await enhanceBugReport({ modelId: 'ghost', title: 't', description: 'broke' });
    expect(res).toMatchObject({ success: false, statusCode: 404 });
  });

  it('returns a parsed, label-filtered enhancement on success', async () => {
    generateChatCompletionMock.mockResolvedValue(
      completionWith(
        JSON.stringify({
          title: 'App crashes on save',
          body: '## Steps\n1. click save',
          labels: ['bug', 'frontend', 'totally-made-up'],
          severity: 'high',
        })
      )
    );
    const res = await enhanceBugReport({ modelId: 'm1', title: 'crash', description: 'it crashes' });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.result.enhanced).toBe(true);
    expect(res.result.title).toBe('App crashes on save');
    expect(res.result.body).toBe('## Steps\n1. click save');
    expect(res.result.labels).toEqual(['bug', 'frontend']);
    expect(res.result.severity).toBe('high');
    // Resolved by display name, not raw id.
    expect(generateChatCompletionMock).toHaveBeenCalledWith(
      expect.objectContaining({ modelIdentifier: 'GPT-4o' })
    );
  });

  it('fails soft (original text, enhanced=false) when the model call fails', async () => {
    generateChatCompletionMock.mockResolvedValue({
      success: false,
      error: { message: 'nope', type: 'x', code: 'y' },
      statusCode: 502,
    });
    const res = await enhanceBugReport({ modelId: 'm1', title: 'crash', description: 'original text here' });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.result.enhanced).toBe(false);
    expect(res.result.body).toBe('original text here');
    expect(res.result.labels).toEqual(['bug']);
  });

  it('fails soft when the model returns unparseable output', async () => {
    generateChatCompletionMock.mockResolvedValue(completionWith('I could not do that'));
    const res = await enhanceBugReport({ modelId: 'm1', title: 'crash', description: 'original text here' });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.result.enhanced).toBe(false);
    expect(res.result.body).toBe('original text here');
  });

  it('fails soft when the model call throws', async () => {
    generateChatCompletionMock.mockRejectedValue(new Error('boom'));
    const res = await enhanceBugReport({ modelId: 'm1', title: 'crash', description: 'kept text' });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.result.enhanced).toBe(false);
    expect(res.result.body).toBe('kept text');
  });
});
