/**
 * paletteTokens — the raw, dependency-free theme palette (issue #150).
 *
 * This module intentionally has NO imports and NO "use client" directive so it
 * can be imported from anywhere, including plain Node contexts (e.g. the Jest
 * contrast regression test) without dragging in React / MUI. `theme.ts`
 * re-exports `themeColors` from here so existing import sites are unchanged.
 *
 * Dark palette design (re-plan after rejection of commit 8f60cd4):
 *  - Surfaces use a LAYERED ramp (background -> surface -> surfaceRaised) with a
 *    clearly perceptible lightness step at each level so cards/menus/inputs
 *    visibly separate from the base instead of melting together.
 *  - Borders are crisp so panels have defined edges.
 *  - Secondary text sits at ~7:1 contrast (the rejected attempt was ~5:1 and
 *    read as washed-out).
 *  - Blue is confined to interactive accents; large fills stay neutral slate.
 */
export const themeColors = {
  light: {
    background: '#FFFFFF',
    foreground: '#2C3E50',
    // surface / surfaceRaised model elevation-1 / elevation-2.
    surface: '#F5F6FA',
    surfaceRaised: '#FFFFFF',
    // Retained for backward compatibility (alias of `surface`).
    paperBackground: '#F5F6FA',
    textSecondary: '#7F8C8D',
    textDisabled: '#9CA3AF',
    border: '#e5e7eb',
    heading: '#111',
    text: '#333',
    secondaryText: '#666',
    error: {
      background: '#fef2f2',
      border: '#fecaca',
      text: '#dc2626'
    },
    // Domain / brand hues tuned for the light surface.
    domain: {
      resource: '#009688',
      resourceSoft: '#4DB6AC',
      signal: '#7E57C2',
      startNode: '#795548',
      codeBackground: '#f5f5f5',
      http: {
        get: '#2e7d32',
        post: '#1565c0',
        put: '#e65100',
        patch: '#6a1b9a',
        delete: '#c62828',
      },
      transport: {
        stdio: { fg: '#1976d2', bg: '#e3f2fd' },
        websocket: { fg: '#2e7d32', bg: '#e8f5e8' },
        sse: { fg: '#f57c00', bg: '#fff3e0' },
        streamable: { fg: '#00796b', bg: '#e0f2f1' },
        default: { fg: '#757575', bg: '#f5f5f5' },
      },
    },
  },
  dark: {
    // Layered slate ramp — each surface is a visible lightness step lighter.
    background: '#0f1319',        // app base            L≈7%
    foreground: '#eef1f5',        // primary text        ~13.5:1 on surface (AAA)
    surface: '#1a212b',           // cards / panels      L≈12% (+5-6% vs base)
    surfaceRaised: '#242d3a',     // menus / popovers / hover  L≈17%
    // Retained for backward compatibility (alias of `surface`).
    paperBackground: '#1a212b',
    textSecondary: '#b4bdca',     // captions            ~7.5:1 on surface (AA)
    textDisabled: '#6b7280',
    border: '#37404e',            // crisp dividers      L≈24%
    heading: '#f5f7fa',
    text: '#eef1f5',
    secondaryText: '#b4bdca',
    error: {
      background: '#2a1618',
      border: '#5a2a2e',
      text: '#ff6b6b'
    },
    // Domain / brand hues tuned (lightened) for the dark surface so they keep
    // their identity while staying legible.
    domain: {
      resource: '#26a69a',
      resourceSoft: '#4DB6AC',
      signal: '#9575CD',
      startNode: '#a1887f',
      codeBackground: '#242d3a',
      http: {
        get: '#66bb6a',
        post: '#5b9dff',
        put: '#ffa726',
        patch: '#ba68c8',
        delete: '#ef5350',
      },
      transport: {
        stdio: { fg: '#90caf9', bg: '#1e2a3a' },
        websocket: { fg: '#a5d6a7', bg: '#1e2e22' },
        sse: { fg: '#ffcc80', bg: '#33281a' },
        streamable: { fg: '#80cbc4', bg: '#17322e' },
        default: { fg: '#b4bdca', bg: '#242d3a' },
      },
    },
  }
} as const;

export type ThemeColors = typeof themeColors;
