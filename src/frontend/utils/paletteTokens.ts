/**
 * paletteTokens — the raw, dependency-free theme palette (issue #150).
 *
 * This module intentionally has NO imports and NO "use client" directive so it
 * can be imported from anywhere, including plain Node contexts (e.g. the Jest
 * contrast regression test) without dragging in React / MUI. `theme.ts`
 * re-exports `themeColors` from here so existing import sites are unchanged.
 *
 * The palette is intentionally neutral at large scale. Violet and cyan appear
 * as controlled interaction/brand light, while content surfaces keep enough
 * separation to remain calm during long flow-building and chat sessions.
 */
export const themeColors = {
  light: {
    background: '#F5F7FF',
    foreground: '#171A2B',
    surface: '#FFFFFF',
    surfaceRaised: '#F8FAFF',
    // Retained for backward compatibility (alias of `surface`).
    paperBackground: '#FFFFFF',
    textSecondary: '#606A84',
    textDisabled: '#929BB1',
    border: '#DEE3F0',
    heading: '#121424',
    text: '#20243A',
    secondaryText: '#606A84',
    error: {
      background: '#FFF2F5',
      border: '#FFC7D2',
      text: '#C62847'
    },
    // Domain / brand hues tuned for the light surface.
    domain: {
      resource: '#008D83',
      resourceSoft: '#36B9AD',
      signal: '#7157D9',
      startNode: '#7A5C50',
      codeBackground: '#F2F4FA',
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
    // Obsidian-violet ramp — perceptible separation without blue-black glare.
    background: '#070912',
    foreground: '#F4F6FF',
    surface: '#12182C',
    surfaceRaised: '#1C243B',
    // Retained for backward compatibility (alias of `surface`).
    paperBackground: '#12182C',
    textSecondary: '#ADB6CC',
    textDisabled: '#69738C',
    border: '#2A324B',
    heading: '#F8F9FF',
    text: '#F4F6FF',
    secondaryText: '#ADB6CC',
    error: {
      background: '#2D151F',
      border: '#633044',
      text: '#FF8298'
    },
    // Domain / brand hues tuned (lightened) for the dark surface so they keep
    // their identity while staying legible.
    domain: {
      resource: '#38C9BC',
      resourceSoft: '#6BDED4',
      signal: '#A694FF',
      startNode: '#C6A69A',
      codeBackground: '#181E32',
      http: {
        get: '#66bb6a',
        post: '#5b9dff',
        put: '#ffa726',
        patch: '#ba68c8',
        delete: '#ef5350',
      },
      transport: {
        stdio: { fg: '#9DCCFF', bg: '#17243A' },
        websocket: { fg: '#9DE3B3', bg: '#172D24' },
        sse: { fg: '#FFD18A', bg: '#322718' },
        streamable: { fg: '#82E2D9', bg: '#15312F' },
        default: { fg: '#ADB6CC', bg: '#1C243B' },
      },
    },
  }
} as const;

export type ThemeColors = typeof themeColors;

/**
 * The palette that shipped before the 2028 visual refresh. Keep it separate
 * from `themeColors` so the modern palette remains a byte-for-byte-compatible
 * export for existing imports while users can still opt into the familiar UI.
 */
export const legacyThemeColors = {
  light: {
    background: '#FFFFFF',
    foreground: '#2C3E50',
    surface: '#F5F6FA',
    surfaceRaised: '#FFFFFF',
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
    background: '#0f1319',
    foreground: '#eef1f5',
    surface: '#1a212b',
    surfaceRaised: '#242d3a',
    paperBackground: '#1a212b',
    textSecondary: '#b4bdca',
    textDisabled: '#6b7280',
    border: '#37404e',
    heading: '#f5f7fa',
    text: '#eef1f5',
    secondaryText: '#b4bdca',
    error: {
      background: '#2a1618',
      border: '#5a2a2e',
      text: '#ff6b6b'
    },
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

export type LegacyThemeColors = typeof legacyThemeColors;
