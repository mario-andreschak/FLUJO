'use client';

import React from 'react';
import { Typography } from '@mui/material';
import type { Theme } from '@mui/material/styles';
import type { Components } from 'react-markdown';

/**
 * Shared link rendering for every react-markdown surface (chat bubbles, tool
 * results, Ask FLUJO, ...).
 *
 * Background: markdown links used to be hard-coded to `primary.main`. In the
 * light "modern" theme the user chat bubble is filled with `primary.light`
 * (#6C5CE2) while `primary.main` is #6355E8 — practically the same violet, so a
 * link inside a user message rendered at ~1.05:1 contrast and was invisible.
 * Assistant bubbles were legible but had no underline, so links were still hard
 * to spot.
 *
 * The fix is a themeable CSS custom property: the surface decides which link
 * color it can carry, the link itself just consumes it and always underlines.
 * The `inherit` fallback means the worst case equals the surrounding body text
 * color, which is guaranteed readable on every surface.
 */
export const LINK_COLOR_VAR = '--flujo-link-color';

/**
 * Accessible link color for a neutral surface (background/paper): the darker
 * primary shade in light mode, the lighter one in dark mode. Both sit far away
 * from the surface luminance, unlike `primary.main`.
 */
export function surfaceLinkColor(theme: Theme): string {
  return theme.palette.mode === 'dark' ? theme.palette.primary.light : theme.palette.primary.dark;
}

/**
 * Link color declarations for a container. Pass `onAccent` for surfaces that are
 * already filled with an accent color (e.g. the user chat bubble): there no
 * brand tint can win, so links inherit the bubble's contrast text color and
 * rely on the underline for affordance.
 */
export function markdownLinkVars(theme: Theme, onAccent = false): Record<string, string> {
  return { [LINK_COLOR_VAR]: onAccent ? 'inherit' : surfaceLinkColor(theme) };
}

/** The `a` renderer: inherits the surface's link color and always underlines. */
export const MarkdownLink: NonNullable<Components['a']> = ({ href, children, ...rest }) => (
  <Typography
    component="a"
    href={href}
    title={rest.title}
    sx={{
      color: `var(${LINK_COLOR_VAR}, inherit)`,
      fontWeight: 500,
      textDecoration: 'underline',
      textDecorationThickness: '1px',
      textUnderlineOffset: '2px',
      // Keep long URLs from blowing out narrow bubbles.
      overflowWrap: 'anywhere',
      '&:hover': { textDecorationThickness: '2px' },
      '&:focus-visible': { outline: '2px solid currentColor', outlineOffset: '2px', borderRadius: '2px' },
    }}
  >
    {children}
  </Typography>
);

/** Drop-in `components` for markdown that only needs the link fix. */
export const MARKDOWN_LINK_COMPONENTS: Components = { a: MarkdownLink };
