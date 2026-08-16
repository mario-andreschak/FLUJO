/** @jest-environment jsdom */

/**
 * Render-level guard for the chat markdown link fix.
 *
 * Links used to be painted with the fixed `primary.main` and no underline, which
 * made them invisible on the accent-filled user bubble in the light modern theme.
 * They now consume the `--flujo-link-color` custom property the surrounding
 * surface publishes and always underline, so affordance survives any palette.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ThemeProvider } from '@mui/material/styles';
import Paper from '@mui/material/Paper';
import { createAppTheme } from '@/frontend/utils/muiTheme';
import {
  LINK_COLOR_VAR,
  MarkdownLink,
  markdownLinkVars,
  surfaceLinkColor,
} from '@/frontend/components/shared/MarkdownLink';

// `react-markdown` ships ESM that this Jest setup does not transform, so the
// renderer is exercised directly - react-markdown only calls it with `href` and
// `children`, which is exactly what is asserted here.

/**
 * All CSS text Emotion has injected into the document. Emotion writes rules
 * through the CSSOM (so `<style>.textContent` stays empty), hence the walk over
 * `document.styleSheets`.
 */
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

describe('markdown links in chat', () => {
  it('renders the anchor with an underline and the surface link variable', () => {
    render(
      <ThemeProvider theme={createAppTheme('light')}>
        <MarkdownLink href="https://example.com/docs">the docs</MarkdownLink>
      </ThemeProvider>,
    );

    const link = screen.getByText('the docs');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://example.com/docs');

    const css = injectedCss();
    // Colour is delegated to the surface, never hard-coded to primary.main.
    expect(css).toContain(`var(${LINK_COLOR_VAR}, inherit)`);
    // Underline means the link is still identifiable when colour contrast is
    // low or the user overrides colours (WCAG 1.4.1).
    expect(css).toMatch(/text-decoration:\s*underline/);
  });

  it('emits the variable through sx so a bubble can re-point it', () => {
    // Proves the plumbing: MUI/Emotion pass custom properties from `sx` straight
    // into the generated class, which is how the chat bubble hands its link
    // colour down to the markdown renderer.
    const theme = createAppTheme('light');
    render(
      <ThemeProvider theme={theme}>
        <Paper data-testid="accent-bubble" sx={(t) => ({ ...markdownLinkVars(t, true) })}>
          <MarkdownLink href="https://example.com">link</MarkdownLink>
        </Paper>
      </ThemeProvider>,
    );

    expect(screen.getByTestId('accent-bubble')).toBeInTheDocument();
    expect(injectedCss()).toMatch(new RegExp(`${LINK_COLOR_VAR}:\\s*inherit`));
  });

  it('keeps non-colour affordances: hover underline, focus-visible outline, safe wrapping', () => {
    // WCAG 1.4.1 / 2.4.7: the link must stay identifiable and focusable even when
    // colour is unavailable, and long URLs must not overflow a narrow bubble.
    render(
      <ThemeProvider theme={createAppTheme('light')}>
        <MarkdownLink href="https://example.com/a-very-long-path-that-would-overflow">long link</MarkdownLink>
      </ThemeProvider>,
    );

    const css = injectedCss();
    expect(css).toMatch(/:hover\s*\{[^}]*text-decoration-thickness:\s*2px/);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid currentColor/);
    expect(css).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('publishes an accessible link colour on neutral surfaces and inherits on accent ones', () => {
    const theme = createAppTheme('light');
    expect(markdownLinkVars(theme)[LINK_COLOR_VAR]).toBe(theme.palette.primary.dark);
    expect(surfaceLinkColor(createAppTheme('dark'))).toBe(createAppTheme('dark').palette.primary.light);
    expect(markdownLinkVars(theme, true)[LINK_COLOR_VAR]).toBe('inherit');
  });
});
