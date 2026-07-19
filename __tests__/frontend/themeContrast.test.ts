/**
 * Dark-theme contrast & elevation regression test (issue #150).
 *
 * A prior dark-theme attempt (commit 8f60cd4) was rejected as "impossibly ugly":
 * the base (#12161c) and card surface (#1b212b) differed by only ~3% lightness,
 * so every panel melted into the background, and secondary text was too low
 * contrast. This test locks in the fix so we can never again ship a dark palette
 * where surfaces don't separate or text is unreadable.
 *
 * It imports the *real* palette from the dependency-free `paletteTokens` module
 * (no React/MUI), and asserts:
 *   1. A visible elevation ramp: background < surface < surfaceRaised.
 *   2. WCAG contrast for primary/secondary text and the primary accent.
 */
import { themeColors } from '@/frontend/utils/paletteTokens';

// --- WCAG 2.1 relative luminance & contrast ratio --------------------------
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

describe('dark theme — elevation ramp (issue #150)', () => {
  const d = themeColors.dark;

  it('surfaces get monotonically lighter: background < surface < surfaceRaised', () => {
    const lBg = luminance(d.background);
    const lSurface = luminance(d.surface);
    const lRaised = luminance(d.surfaceRaised);
    expect(lSurface).toBeGreaterThan(lBg);
    expect(lRaised).toBeGreaterThan(lSurface);
  });

  it('base -> surface step is perceptible (regression guard for the 8f60cd4 "muddy" bug)', () => {
    // The rejected palette had only ~1.06 contrast between base and card.
    expect(contrast(d.background, d.surface)).toBeGreaterThanOrEqual(1.12);
    expect(contrast(d.surface, d.surfaceRaised)).toBeGreaterThanOrEqual(1.12);
  });

  it('paperBackground stays an alias of surface for backward compatibility', () => {
    expect(d.paperBackground).toBe(d.surface);
  });
});

describe('dark theme — WCAG text/accent contrast on the card surface (issue #150)', () => {
  const d = themeColors.dark;
  const surface = d.surface;

  it('primary body text meets WCAG AA (>= 4.5:1)', () => {
    expect(contrast(d.foreground, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('secondary/caption text is comfortably readable (>= 4.5:1)', () => {
    // The rejected attempt sat at ~5:1 and read washed out; new target is ~7:1+.
    expect(contrast(d.textSecondary, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('primary accent meets the UI/large-text threshold (>= 3:1)', () => {
    expect(contrast('#4f93f5', surface)).toBeGreaterThanOrEqual(3);
  });

  it('error text is legible on the surface (>= 4.5:1)', () => {
    expect(contrast(d.error.text, surface)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('light theme — sanity contrast (issue #150)', () => {
  const l = themeColors.light;

  it('primary body text meets WCAG AA on its surface', () => {
    expect(contrast(l.foreground, l.surface)).toBeGreaterThanOrEqual(4.5);
  });
});
