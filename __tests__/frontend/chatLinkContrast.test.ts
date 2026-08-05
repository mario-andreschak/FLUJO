/**
 * Chat markdown link legibility regression test.
 *
 * Bug: in the light "modern" theme links inside chat messages were barely
 * visible. Markdown links were hard-coded to `primary.main` (#6355E8) while the
 * user bubble is filled with `primary.light` (#6C5CE2) — the same violet, so a
 * link sat at ~1.05:1 contrast against its own bubble. On the neutral assistant
 * bubble `primary.main` was legible-ish (~5.8:1 on white) but had no underline,
 * so links were still hard to spot.
 *
 * The fix publishes a `--flujo-link-color` custom property per surface:
 *   - neutral surfaces (paper/background) get the primary shade that actually
 *     contrasts with them (primary.dark in light mode, primary.light in dark),
 *   - accent-filled surfaces (user/system bubbles) inherit the bubble's own text
 *     color, which is the standard treatment for links on colored bubbles,
 * and the link renderer always underlines, so affordance no longer depends on
 * color alone (WCAG 1.4.1 "Use of Color").
 */
import { createAppTheme, createLegacyAppTheme } from '@/frontend/utils/muiTheme';
import {
  LINK_COLOR_VAR,
  markdownLinkVars,
  surfaceLinkColor,
} from '@/frontend/components/shared/MarkdownLink';

// --- WCAG 2.1 relative luminance & contrast ratio --------------------------
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Accepts #rgb / #rrggbb / rgb(...) / rgba(...) as produced by the palettes. */
function rgb(color: string): [number, number, number] {
  const value = color.trim();
  const fn = value.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const parts = fn[1].split(',').map((p) => parseFloat(p));
    return [parts[0], parts[1], parts[2]];
  }
  let hex = value.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  return [
    parseInt(hex.substring(0, 2), 16),
    parseInt(hex.substring(2, 4), 16),
    parseInt(hex.substring(4, 6), 16),
  ];
}

function luminance(color: string): number {
  const [r, g, b] = rgb(color);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe.each([
  ['modern', createAppTheme],
  ['legacy', createLegacyAppTheme],
] as const)('%s theme — chat link contrast', (_style, factory) => {
  describe.each(['light', 'dark'] as const)('%s mode', (mode) => {
    const theme = factory(mode);
    const link = surfaceLinkColor(theme);

    it('links on the assistant bubble (paper) meet WCAG AA (>= 4.5:1)', () => {
      expect(contrast(link, theme.palette.background.paper)).toBeGreaterThanOrEqual(4.5);
    });

    it('links on the page background meet WCAG AA (>= 4.5:1)', () => {
      expect(contrast(link, theme.palette.background.default)).toBeGreaterThanOrEqual(4.5);
    });

    it('the surface link color beats the old hard-coded primary.main', () => {
      const paper = theme.palette.background.paper;
      expect(contrast(link, paper)).toBeGreaterThan(contrast(theme.palette.primary.main, paper));
    });

    it('neutral surfaces publish the accessible shade, accent surfaces inherit', () => {
      expect(markdownLinkVars(theme)).toEqual({ [LINK_COLOR_VAR]: link });
      // On an accent-filled bubble no brand tint can win (that was the bug), so
      // the link takes the bubble's own contrast text color.
      expect(markdownLinkVars(theme, true)).toEqual({ [LINK_COLOR_VAR]: 'inherit' });
    });

    it('regression: primary.main was invisible on the user bubble, inheriting is not', () => {
      const bubble = theme.palette.primary.light; // user bubble fill
      const inherited = theme.palette.primary.contrastText; // what `inherit` resolves to
      expect(contrast(inherited, bubble)).toBeGreaterThan(contrast(theme.palette.primary.main, bubble));
    });
  });
});

describe('light modern theme — the reported surface', () => {
  const theme = createAppTheme('light');

  it('had an effectively invisible link on the user bubble before the fix', () => {
    // Documents the original defect: violet link on violet bubble.
    expect(contrast(theme.palette.primary.main, theme.palette.primary.light)).toBeLessThan(1.2);
  });

  it('now renders user-bubble links at the bubble text contrast (WCAG AA)', () => {
    expect(
      contrast(theme.palette.primary.contrastText, theme.palette.primary.light),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('assistant-bubble links are comfortably readable (>= 7:1 where possible)', () => {
    expect(
      contrast(surfaceLinkColor(theme), theme.palette.background.paper),
    ).toBeGreaterThanOrEqual(7);
  });
});
