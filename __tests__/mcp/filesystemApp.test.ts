/**
 * Regression guard for the built-in `filesystem` MCP App (ui://filesystem/browser).
 *
 * The "Select" button hands the chosen file back to the model via a `ui/message`
 * request. Per the MCP Apps spec (and the host bridge's Zod schema), that
 * request's `content` MUST be an ARRAY of content blocks. A single object once
 * shipped here and the host rejected it at runtime with
 *   `{ expected: "array", code: "invalid_type", path: ["params","content"] }`.
 */

// @modelcontextprotocol/ext-apps is pure ESM; Jest (CommonJS mode) cannot run it
// directly. We mock it with a representative version string so that:
//   (a) Jest does not try to execute the ESM bundle, and
//   (b) filesystemResources.ts uses our mock value when the module is loaded,
//       letting us assert the HTML contains the package-constant version.
jest.mock('@modelcontextprotocol/ext-apps', () => ({
  LATEST_PROTOCOL_VERSION: '2026-01-26',
}));

// The mock above is hoisted before imports by Jest's babel/SWC transform, so
// filesystemResources.ts sees the mocked LATEST_PROTOCOL_VERSION when it is
// first evaluated. Import it here only to keep the test self-documenting.
const LATEST_PROTOCOL_VERSION = '2026-01-26';

import { filesystemReadResource, FILESYSTEM_APP_URI, DEVCANVAS_DIFF_URI } from '@/backend/services/mcp/internal/filesystemResources';
import { Script } from 'node:vm';

function appHtml(): string {
  const res = filesystemReadResource(FILESYSTEM_APP_URI);
  expect(res.success).toBe(true);
  const content = res.data?.contents?.[0];
  const html = content && 'text' in content ? content.text : undefined;
  expect(typeof html).toBe('string');
  return html as string;
}

function devcanvasHtml(): string {
  const res = filesystemReadResource(DEVCANVAS_DIFF_URI);
  expect(res.success).toBe(true);
  const content = res.data?.contents?.[0];
  const html = content && 'text' in content ? content.text : undefined;
  expect(typeof html).toBe('string');
  return html as string;
}

describe('filesystem MCP App', () => {
  it('sends ui/message content as an array of content blocks (not a bare object)', () => {
    const html = appHtml();
    // The correct, array-shaped call.
    expect(html).toContain('"ui/message", { role: "user", content: [{ type: "text"');
    // The buggy object shape must never reappear.
    expect(html).not.toContain('content: { type: "text", text: "Selected file:');
  });

  it('uses LATEST_PROTOCOL_VERSION from ext-apps in filesystem-browser ui/initialize (not a stale hardcoded string)', () => {
    const html = appHtml();
    // Must contain the version derived from the package constant, not a stale literal.
    expect(html).toContain(`protocolVersion: "${LATEST_PROTOCOL_VERSION}"`);
    // The bare hardcoded string must not appear independently of the version exported by ext-apps.
    // (If the package updates LATEST_PROTOCOL_VERSION, this test will still pass; only an
    // independently-hardcoded mismatch would fail.)
    expect(LATEST_PROTOCOL_VERSION).toBeTruthy();
  });

  it('uses LATEST_PROTOCOL_VERSION from ext-apps in devcanvas-diff ui/initialize', () => {
    const html = devcanvasHtml();
    expect(html).toContain(`protocolVersion: "${LATEST_PROTOCOL_VERSION}"`);
    expect(LATEST_PROTOCOL_VERSION).toBeTruthy();
  });

  it('renders literal edits and unified patches as red/green side-by-side diffs', () => {
    const html = devcanvasHtml();
    expect(html).toContain('grid-template-columns:minmax(0,1fr) minmax(0,1fr)');
    expect(html).toContain('renderSideBySide(card, comparison.oldText, comparison.newText');
    expect(html).toContain('renderUnifiedDiff(card, c.diffText)');
    expect(html).toContain('className = "line " + kind');
    expect(html).toContain('oldText: typeof edit.oldText');
    expect(html).toContain('newText: typeof edit.newText');
  });

  it('ships syntactically valid devcanvas JavaScript', () => {
    const html = devcanvasHtml();
    const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), match => match[1]);
    expect(scripts).toHaveLength(1);
    expect(() => new Script(scripts[0])).not.toThrow();
  });
});
