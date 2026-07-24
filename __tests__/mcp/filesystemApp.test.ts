/**
 * Regression guard for the built-in `filesystem` MCP App (ui://filesystem/browser).
 *
 * The "Select" button hands the chosen file back to the model via a `ui/message`
 * request. Per the MCP Apps spec (and the host bridge's Zod schema), that
 * request's `content` MUST be an ARRAY of content blocks. A single object once
 * shipped here and the host rejected it at runtime with
 *   `{ expected: "array", code: "invalid_type", path: ["params","content"] }`.
 */
import { filesystemReadResource, FILESYSTEM_APP_URI } from '@/backend/services/mcp/internal/filesystemResources';

function appHtml(): string {
  const res = filesystemReadResource(FILESYSTEM_APP_URI);
  expect(res.success).toBe(true);
  const html = res.data?.contents?.[0]?.text;
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
});
