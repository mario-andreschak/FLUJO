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
  writeScreenshotArtifact,
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
  description: 'Optional browser session identifier. When omitted, the most recently used live session is reused.',
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
      description: 'Open or reuse an isolated incognito browser session, optionally navigating to an allowed HTTP(S) URL. Omitting sessionId reuses the most recently used live session, or creates one when none exists.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { ...SESSION_PROPERTY, description: 'Optional stable id. Omit it to reuse the most recently used live session, or create one when none exists.' },
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
        required: ['url'],
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_back',
      description: 'Navigate an existing browser session backward in its page history.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: SESSION_PROPERTY, timeoutMs: TIMEOUT_PROPERTY },
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_forward',
      description: 'Navigate an existing browser session forward in its page history.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: SESSION_PROPERTY, timeoutMs: TIMEOUT_PROPERTY },
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_reload',
      description: 'Reload the current page in an existing browser session.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: SESSION_PROPERTY, timeoutMs: TIMEOUT_PROPERTY },
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
        additionalProperties: false,
      },
      annotations: READ_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_click',
      description: 'Click either the first element matching a selector or viewport coordinates in an existing browser session.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: SESSION_PROPERTY,
          selector: { type: 'string', minLength: 1, maxLength: MAX_SELECTOR_CHARS },
          x: { type: 'number', minimum: 0, description: 'Viewport x coordinate in CSS pixels.' },
          y: { type: 'number', minimum: 0, description: 'Viewport y coordinate in CSS pixels.' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
          clickCount: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
          timeoutMs: TIMEOUT_PROPERTY,
        },
        anyOf: [{ required: ['selector'] }, { required: ['x', 'y'] }],
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_type',
      description: 'Fill an element matching a selector, or type into the currently focused page element; optionally press Enter afterward.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: SESSION_PROPERTY,
          selector: { type: 'string', minLength: 1, maxLength: MAX_SELECTOR_CHARS },
          text: { type: 'string', maxLength: 100000 },
          submit: { type: 'boolean', default: false },
          timeoutMs: TIMEOUT_PROPERTY,
        },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_press',
      description: 'Press a keyboard key or shortcut in the currently focused page element.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: SESSION_PROPERTY,
          key: { type: 'string', minLength: 1, maxLength: 100, description: 'Patchright key name or shortcut, such as Enter, Tab, ArrowDown, or Control+A.' },
          timeoutMs: TIMEOUT_PROPERTY,
        },
        required: ['key'],
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_scroll',
      description: 'Scroll the current page by viewport-relative pixel deltas.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: SESSION_PROPERTY,
          deltaX: { type: 'number', minimum: -100000, maximum: 100000, default: 0 },
          deltaY: { type: 'number', minimum: -100000, maximum: 100000, default: 0 },
          timeoutMs: TIMEOUT_PROPERTY,
        },
        anyOf: [{ required: ['deltaX'] }, { required: ['deltaY'] }],
        additionalProperties: false,
      },
      annotations: INTERACTION_ANNOTATIONS,
      _meta: APP_META,
    },
    {
      name: 'browser_screenshot',
      description: 'Capture a PNG screenshot, persist it under the FLUJO data directory, and report its full absolute file path.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: SESSION_PROPERTY,
          fullPage: { type: 'boolean', default: false },
          timeoutMs: TIMEOUT_PROPERTY,
        },
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

function finiteNumberArg(args: Record<string, unknown>, key: string, fallback?: number): number {
  const value = args[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BrowserMcpError('INVALID_ARGUMENT', `${key} must be a finite number.`);
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
      let sessionId: string;
      if (args.sessionId === undefined || args.sessionId === '') {
        try {
          sessionId = getSession(undefined).id;
        } catch (error) {
          if (error instanceof BrowserMcpError && error.code === 'NOT_FOUND') {
            return success({ success: true, sessionId: null, closed: false });
          }
          throw error;
        }
      } else {
        sessionId = stringArg(args, 'sessionId', 64);
      }
      const closed = await closeSession(sessionId);
      return success({ success: true, sessionId, closed });
    }

    const session = getSession(args.sessionId);
    const timeout = timeoutMs(args.timeoutMs);
    if (name === 'browser_navigate') {
      return success(await navigate(session, stringArg(args, 'url', 8_192), timeout, signal));
    }
    if (name === 'browser_back' || name === 'browser_forward' || name === 'browser_reload') {
      resetNavigationCounter(session);
      const data = await runCancellable(session, signal, async () => {
        if (name === 'browser_back') {
          await session.page.goBack({ waitUntil: 'domcontentloaded', timeout });
        } else if (name === 'browser_forward') {
          await session.page.goForward({ waitUntil: 'domcontentloaded', timeout });
        } else {
          await session.page.reload({ waitUntil: 'domcontentloaded', timeout });
        }
        if (session.navigationBlocked) {
          throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The history navigation was blocked by browser policy.');
        }
        return pageState(session, timeout);
      });
      return success(data);
    }
    if (name === 'browser_snapshot') {
      return success(await runCancellable(session, signal, () => pageState(session, timeout)));
    }
    if (name === 'browser_click') {
      resetNavigationCounter(session);
      const data = await runCancellable(session, signal, async () => {
        if (args.button !== undefined && !['left', 'right', 'middle'].includes(String(args.button))) {
          throw new BrowserMcpError('INVALID_ARGUMENT', 'button must be left, right, or middle.');
        }
        const button = args.button === 'right' || args.button === 'middle' ? args.button : 'left';
        const clickCount = finiteNumberArg(args, 'clickCount', 1);
        if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3) {
          throw new BrowserMcpError('INVALID_ARGUMENT', 'clickCount must be an integer from 1 to 3.');
        }
        if (typeof args.selector === 'string' && args.selector.length > 0) {
          if (args.selector.length > MAX_SELECTOR_CHARS) {
            throw new BrowserMcpError('INVALID_ARGUMENT', `selector must be no longer than ${MAX_SELECTOR_CHARS} characters.`);
          }
          await session.page.locator(args.selector).first().click({ timeout, button, clickCount });
        } else {
          const x = finiteNumberArg(args, 'x');
          const y = finiteNumberArg(args, 'y');
          const viewport = session.page.viewportSize();
          if (x < 0 || y < 0 || (viewport && (x >= viewport.width || y >= viewport.height))) {
            throw new BrowserMcpError('INVALID_ARGUMENT', 'Click coordinates must be inside the current viewport.');
          }
          await session.page.mouse.click(x, y, { button, clickCount });
        }
        await session.page.waitForLoadState('domcontentloaded', { timeout }).catch(() => undefined);
        if (session.navigationBlocked) {
          throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The interaction attempted a navigation blocked by browser policy.');
        }
        return pageState(session, timeout);
      });
      return success(data);
    }
    if (name === 'browser_type') {
      const text = args.text;
      if (typeof text !== 'string' || text.length > 100_000) {
        throw new BrowserMcpError('INVALID_ARGUMENT', 'text must be a string no longer than 100000 characters.');
      }
      resetNavigationCounter(session);
      const data = await runCancellable(session, signal, async () => {
        if (typeof args.selector === 'string' && args.selector.length > 0) {
          if (args.selector.length > MAX_SELECTOR_CHARS) {
            throw new BrowserMcpError('INVALID_ARGUMENT', `selector must be no longer than ${MAX_SELECTOR_CHARS} characters.`);
          }
          const locator = session.page.locator(args.selector).first();
          await locator.fill(text, { timeout });
          if (args.submit === true) await locator.press('Enter', { timeout });
        } else {
          await session.page.keyboard.insertText(text);
          if (args.submit === true) await session.page.keyboard.press('Enter');
        }
        if (session.navigationBlocked) {
          throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The interaction attempted a navigation blocked by browser policy.');
        }
        return pageState(session, timeout);
      });
      return success(data);
    }
    if (name === 'browser_press') {
      const key = stringArg(args, 'key', 100);
      resetNavigationCounter(session);
      const data = await runCancellable(session, signal, async () => {
        await session.page.keyboard.press(key);
        await session.page.waitForLoadState('domcontentloaded', { timeout }).catch(() => undefined);
        if (session.navigationBlocked) {
          throw new BrowserMcpError('NAVIGATION_BLOCKED', 'The keyboard interaction attempted a navigation blocked by browser policy.');
        }
        return pageState(session, timeout);
      });
      return success(data);
    }
    if (name === 'browser_scroll') {
      const deltaX = finiteNumberArg(args, 'deltaX', 0);
      const deltaY = finiteNumberArg(args, 'deltaY', 0);
      if (Math.abs(deltaX) > 100_000 || Math.abs(deltaY) > 100_000) {
        throw new BrowserMcpError('INVALID_ARGUMENT', 'Scroll deltas must be between -100000 and 100000.');
      }
      const data = await runCancellable(session, signal, async () => {
        await session.page.mouse.wheel(deltaX, deltaY);
        return pageState(session, timeout);
      });
      return success(data);
    }
    if (name === 'browser_screenshot') {
      const fullPage = args.fullPage === true;
      const png = await runCancellable(session, signal, () => session.page.screenshot({
        type: 'png',
        fullPage,
        timeout,
      }));
      if (png.length > MAX_SCREENSHOT_BYTES) {
        throw new BrowserMcpError('INVALID_ARGUMENT', 'The screenshot exceeded the 5 MB artifact limit.');
      }
      const filePath = await writeScreenshotArtifact(session.id, fullPage, png);
      const data = {
        success: true,
        ...publicPageState(session),
        path: filePath,
        mimeType: 'image/png',
        bytes: png.length,
        viewport: session.page.viewportSize(),
      };
      return success(data, [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]);
    }
    return failure('NOT_FOUND', `Unknown browser tool: ${name}`);
  } catch (error) {
    const normalized = normalizedError(error);
    return failure(normalized.code, normalized.message);
  }
}
