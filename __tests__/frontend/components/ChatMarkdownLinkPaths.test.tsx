/** @jest-environment jsdom */

/**
 * Issue #402 — "links barely readable in modern light theme".
 *
 * The colour fix lives in `MarkdownLink` (a `--flujo-link-color` custom property
 * published per surface plus a permanent underline). That fix only reaches the
 * screen if *every* chat markdown path hands its `a` renderer to react-markdown.
 * The multipart (`content: [{ type: 'text' }]`) path used to render a bare
 * `<ReactMarkdown>` without the component map, so links inside multipart
 * assistant/user messages fell back to the UA anchor and stayed invisible on the
 * accent-filled bubble in the light modern theme.
 *
 * These tests drive both content shapes through `ChatMessages` and assert the
 * anchors come from the shared renderer.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ThemeProvider } from '@mui/material/styles';
import ChatMessages from '@/frontend/components/Chat/ChatMessages';
import { createAppTheme } from '@/frontend/utils/muiTheme';
import { LINK_COLOR_VAR, markdownLinkVars } from '@/frontend/components/shared/MarkdownLink';
import type { FlujoChatMessage } from '@/shared/types/chat';

// `react-markdown` ships ESM this Jest setup does not transform. The stand-in
// mimics the single behaviour under test: it resolves one markdown link and
// renders it through the caller's `components.a`, falling back to a plain
// (class-less) anchor when no renderer was provided — exactly what the bug was.
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children, components }: { children?: React.ReactNode; components?: any }) => {
    const source = typeof children === 'string' ? children : '';
    const link = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(source);
    if (!link) return <>{children}</>;
    const Anchor = components?.a;
    return Anchor
      ? <Anchor href={link[2]}>{link[1]}</Anchor>
      : <a href={link[2]}>{link[1]}</a>;
  },
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));

/** Every CSS rule Emotion injected (it writes through the CSSOM, not textContent). */
function injectedCss(): string {
  const fromSheets = Array.from(document.styleSheets).flatMap((sheet) => {
    try {
      return Array.from(sheet.cssRules).map((rule) => rule.cssText);
    } catch {
      return [];
    }
  });
  const fromTags = Array.from(document.querySelectorAll('style')).map((node) => node.textContent ?? '');
  return [...fromSheets, ...fromTags].join('\n');
}

function renderChat(messages: FlujoChatMessage[]) {
  return render(
    <ThemeProvider theme={createAppTheme('light')}>
      <ChatMessages
        messages={messages}
        conversationId="conversation-402"
        onToggleDisabled={() => undefined}
        onSplitConversation={() => undefined}
      />
    </ThemeProvider>,
  );
}

/** A shared-renderer anchor is a MUI Typography; the UA fallback has no class. */
function expectSharedRendererAnchor(label: string) {
  const link = screen.getByText(label);
  expect(link.tagName).toBe('A');
  expect(link.className).toMatch(/MuiTypography-root/);
  return link;
}

describe('chat markdown links (#402)', () => {
  it('routes string message content through the shared link renderer', () => {
    renderChat([
      {
        id: 'user-1',
        timestamp: 1,
        role: 'user',
        content: 'see [the docs](https://example.com/docs) please',
      } as FlujoChatMessage,
    ]);

    const link = expectSharedRendererAnchor('the docs');
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(injectedCss()).toContain(`var(${LINK_COLOR_VAR}, inherit)`);
  });

  it('routes multipart text content through the shared link renderer too', () => {
    renderChat([
      {
        id: 'assistant-1',
        timestamp: 2,
        role: 'assistant',
        content: [{ type: 'text', text: 'read [the spec](https://example.com/spec)' }],
      } as unknown as FlujoChatMessage,
    ]);

    const link = expectSharedRendererAnchor('the spec');
    expect(link).toHaveAttribute('href', 'https://example.com/spec');
    expect(injectedCss()).toContain(`var(${LINK_COLOR_VAR}, inherit)`);
  });

  it('publishes an inherited link colour on accent bubbles and a tinted one on neutral bubbles', () => {
    const theme = createAppTheme('light');
    renderChat([
      {
        id: 'user-2',
        timestamp: 1,
        role: 'user',
        content: 'accent [bubble link](https://example.com/a)',
      } as FlujoChatMessage,
      {
        id: 'assistant-2',
        timestamp: 2,
        role: 'assistant',
        content: [{ type: 'text', text: 'neutral [bubble link](https://example.com/b)' }],
      } as unknown as FlujoChatMessage,
    ]);

    const values = Array.from(
      injectedCss().matchAll(new RegExp(`${LINK_COLOR_VAR}:\\s*([^;}]+)`, 'g')),
    ).map((match) => match[1].trim().toLowerCase());

    // Accent-filled user bubble: no brand tint can win there, so the link takes
    // the bubble's own contrast text colour (that was the reported defect).
    expect(values).toContain('inherit');
    // Neutral assistant bubble: the surface-aware primary shade, never the old
    // hard-coded `primary.main`.
    expect(values.some((value) => value !== 'inherit')).toBe(true);
    expect(values).not.toContain(theme.palette.primary.main.toLowerCase());
    expect(markdownLinkVars(theme)[LINK_COLOR_VAR]).toBe(theme.palette.primary.dark);
  });
});
