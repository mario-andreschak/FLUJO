import type { CallToolResult, Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import {
  BrowserMcpError,
  assertNavigationAllowed,
  closeSession,
  getSession,
  openSession,
  publicPageState,
  resetNavigationCounter,
  runCancellable,
  timeoutMs,
  type BrowserErrorCode,
  type BrowserSession,
} from './runtime.js';
import { BROWSER_APP_URI } from './resources.js';

const MAX_TEXT_CHARS = 50_000;
const MAX_SELECTOR_CHARS = 2_000;
const MAX_SCREENSHOT_BYTES = 5_000_000;
const READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const INTERACTION_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};
const APP_META = {
  ui: {
    resourceUri: BROWSER_APP_URI,
    visibility: ['model', 'app'],
  },
};

const SESSION_PROPERTY = {
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{1,64}$',
  description: 'Opaque browser session identifier returned by browser_open.',
} as const;
const TIMEOUT_PROPERTY = {
  type: 'number',
  minimum: 1000,
  maximum: 60000,
  description: 'Operation timeout in milliseconds (default 30000).',
} as const;

export function browserToolDefinitions(): Tool[] {
  return [
    {
      name: 'browser_open',
      description: 'Open an isolated incognito browser session, optionally navigating to an allowed HTTP(S) URL.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { ...SESSION_PROPERTY, description: 'Optional stable id for bounded session reuse.' },
          url: { type: 'string', description: 'Optional initial HTTP(S) URL.' },
          timeoutMs: TIMEOUT_PROPERTY,
        },
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_navigate',
      description: 'Navigate an existing isolated browser session to an allowed HTTP(S) URL.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: SESSION_PROPERTY, url: { type: 'string' }, timeoutMs: TIMEOUT_PROPERTY },
        required: ['sessionId', 'url'],
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_snapshot',
      description: 'Read the current page title, URL, and bounded visible body text without exposing cookies or storage.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: SESSION_PROPERTY, timeoutMs: TIMEOUT_PROPERTY },
        required: ['sessionId'],
        additionalProperties: false,
      },
      annotations: READ_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_click',
      description: 'Click the first element matching an explicit selector in an existing browser session.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: SESSION_PROPERTY,
          selector: { type: 'string', minLength: 1, maxLength: MAX_SELECTOR_CHARS },
          timeoutMs: TIMEOUT_PROPERTY,
        },
        required: ['sessionId', 'selector'],
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_type',
      description: 'Fill the first element matching an explicit selector; optionally press Enter afterward.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: SESSION_PROPERTY,
          selector: { type: 'string', minLength: 1, maxLength: MAX_SELECTOR_CHARS },
          text: { type: 'string', maxLength: 100000 },
          submit: { type: 'boolean', default: false },
          timeoutMs: TIMEOUT_PROPERTY,
        },
        required: ['sessionId', 'selector', 'text'],
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_screenshot',
      description: 'Capture a PNG screenshot of the current page in memory; no host filesystem path is exposed.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: SESSION_PROPERTY,
          fullPage: { type: 'boolean', default: false },
          timeoutMs: TIMEOUT_PROPERTY,
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      annotations: READ_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_close',
      description: 'Close an isolated browser session and discard its cookies, storage, and temporary state.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: SESSION_PROPERTY },
        required: ['sessionId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      _meta: APP_META,
    },
  ];
}

function success(data: Record<string, unknown>, extraContent: CallToolResult['content'] = []): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }, ...extraContent],
    structuredContent: data,
  };
}

function failure(code: BrowserErrorCode, message: string): CallToolResult {
  const data = { success: false, error: { code, message } };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function normalizedError(error: unknown): BrowserMcpError {
  if (error instanceof BrowserMcpError) return error;
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  if (name === 'TimeoutError' || /timeout/i.test(name)) {
    return new BrowserMcpError('TIMEOUT', 'The browser operation timed out.');
  }
  if (/ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(message)) {
    return new BrowserMcpError('NAVIGATION_BLOCKED', 'The navigation was blocked by browser policy.');
  }
  if (/Target page, context or browser has been closed|browser has disconnected/i.test(message)) {
    return new BrowserMcpError('BROWSER_UNAVAILABLE', 'The browser process became unavailable; open a new session.');
  }
  return new BrowserMcpError('UNEXPECTED', 'The browser operation failed.');
}

function objectArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrowserMcpError('INVALID_ARGUMENT', 'Tool arguments must be an object.');
  }
  return value as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, key: string, maxLength = 100_000): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new BrowserMcpError('INVALID_ARGUMENT', `${key} must be a non-empty string no longer than ${maxLength} characters.`);
  }
  return value;
}

async function pageState(session: BrowserSession, timeout: number): Promise<Record<string, unknown>> {
  const [title, bodyText] = await Promise.all([
    session.page.title(),
    session.page.locator('body').innerText({ timeout }).catch(() => ''),
  ]);
  const text = bodyText.length > MAX_TEXT_CHARS
    ? `${bodyText.slice(0, MAX_TEXT_CHARS)}\n…[truncated]`
    : bodyText;
  return { success: true, ...publicPageState(session), title, text };
}

async function navigate(session: BrowserSession, rawUrl: string, timeout: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  const url = await assertNavigationAllowed(rawUrl);
  resetNavigationCounter(session);
  return runCancellable(session, signal, async () => {
    try {
      await session.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout });
    } catch (error) {
      if (session.navigationBlocked) {
        throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The navigation or one of its redirects was blocked by browser policy.');
      }
      throw error;
    }
    return pageState(session, timeout);
  });
}

export async function browserCallTool(
  name: string,
  rawArgs: unknown,
  signal: AbortSignal,
): Promise<CallToolResult> {
  try {
    const args = objectArgs(rawArgs);
    if (name === 'browser_open') {
      const session = await openSession(args.sessionId, signal);
      const timeout = timeoutMs(args.timeoutMs);
      const data = typeof args.url === 'string' && args.url.length > 0
        ? await navigate(session, args.url, timeout, signal)
        : { success: true, ...publicPageState(session) };
      return success(data);
    }
    if (name === 'browser_close') {
      const sessionId = stringArg(args, 'sessionId', 64);
      const closed = await closeSession(sessionId);
      return success({ success: true, sessionId, closed });
    }

    const session = getSession(args.sessionId);
    const timeout = timeoutMs(args.timeoutMs);
    if (name === 'browser_navigate') {
      return success(await navigate(session, stringArg(args, 'url', 8_192), timeout, signal));
    }
    if (name === 'browser_snapshot') {
      return success(await runCancellable(session, signal, () => pageState(session, timeout)));
    }
    if (name === 'browser_click') {
      const selector = stringArg(args, 'selector', MAX_SELECTOR_CHARS);
      resetNavigationCounter(session);
      const data = await runCancellable(session, signal, async () => {
        await session.page.locator(selector).first().click({ timeout });
        await session.page.waitForLoadState('domcontentloaded', { timeout }).catch(() => undefined);
        if (session.navigationBlocked) {
          throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The interaction attempted a navigation blocked by browser policy.');
        }
        return pageState(session, timeout);
      });
      return success(data);
    }
    if (name === 'browser_type') {
      const selector = stringArg(args, 'selector', MAX_SELECTOR_CHARS);
      const text = args.text;
      if (typeof text !== 'string' || text.length > 100_000) {
        throw new BrowserMcpError('INVALID_ARGUMENT', 'text must be a string no longer than 100000 characters.');
      }
      resetNavigationCounter(session);
      const data = await runCancellable(session, signal, async () => {
        const locator = session.page.locator(selector).first();
        await locator.fill(text, { timeout });
        if (args.submit === true) await locator.press('Enter', { timeout });
        if (session.navigationBlocked) {
          throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The interaction attempted a navigation blocked by browser policy.');
        }
        return pageState(session, timeout);
      });
      return success(data);
    }
    if (name === 'browser_screenshot') {
      const png = await runCancellable(session, signal, () => session.page.screenshot({
        type: 'png',
        fullPage: args.fullPage === true,
        timeout,
      }));
      if (png.length > MAX_SCREENSHOT_BYTES) {
        throw new BrowserMcpError('INVALID_ARGUMENT', 'The screenshot exceeded the 5 MB artifact limit.');
      }
      const data = { success: true, ...publicPageState(session), mimeType: 'image/png', bytes: png.length };
      return success(data, [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]);
    }
    return failure('NOT_FOUND', `Unknown browser tool: ${name}`);
  } catch (error) {
    const normalized = normalizedError(error);
    return failure(normalized.code, normalized.message);
  }
}
