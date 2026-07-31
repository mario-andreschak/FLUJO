/**
 * Stable destinations in the Living Watershed. Coordinates are percentages of
 * the full illustrated world, keeping the route map independent of its renderer.
 */
export type RiverSceneId =
  | 'home'
  | 'models'
  | 'mcp'
  | 'flows'
  | 'chat'
  | 'automations'
  | 'waves'
  | 'packages'
  | 'statistics'
  | 'docs'
  | 'settings';

export type LandmarkKind =
  | 'overlook'
  | 'spring'
  | 'harbor'
  | 'workshop'
  | 'cove'
  | 'lockworks'
  | 'observatory'
  | 'market'
  | 'gauge'
  | 'archive'
  | 'control-house';

export interface RiverScene {
  id: RiverSceneId;
  label: string;
  eyebrow: string;
  x: number;
  y: number;
  zoom: number;
  accent: string;
  landmark: LandmarkKind;
}

export const RIVER_SCENES = {
  home: {
    id: 'home',
    label: 'River Overlook',
    eyebrow: 'Welcome to FLUJO',
    x: 50,
    y: 46,
    zoom: 1,
    accent: flowNodeColors.dark.resource,
    landmark: 'overlook',
  },
  models: {
    id: 'models',
    label: 'Headwater Springs',
    eyebrow: 'AI setup',
    x: 14,
    y: 23,
    zoom: 1.14,
    accent: flowNodeColors.dark.mcp,
    landmark: 'spring',
  },
  mcp: {
    id: 'mcp',
    label: 'Connector Harbor',
    eyebrow: 'Connected apps',
    x: 29,
    y: 47,
    zoom: 1.1,
    accent: flowNodeColors.light.resource,
    landmark: 'harbor',
  },
  flows: {
    id: 'flows',
    label: 'Flowwright Workshop',
    eyebrow: 'Flow builder',
    x: 43,
    y: 29,
    zoom: 1.16,
    accent: flowNodeColors.dark.subflow,
    landmark: 'workshop',
  },
  chat: {
    id: 'chat',
    label: 'Conversation Cove',
    eyebrow: 'Talk',
    x: 57,
    y: 53,
    zoom: 1.12,
    accent: flowNodeColors.dark.process,
    landmark: 'cove',
  },
  automations: {
    id: 'automations',
    label: 'The Lockworks',
    eyebrow: 'Automations',
    x: 70,
    y: 31,
    zoom: 1.13,
    accent: flowNodeColors.light.trigger,
    landmark: 'lockworks',
  },
  waves: {
    id: 'waves',
    label: 'Wave Observatory',
    eyebrow: 'Automation timeline',
    x: 85,
    y: 52,
    zoom: 1.17,
    accent: flowNodeColors.light.process,
    landmark: 'observatory',
  },
  packages: {
    id: 'packages',
    label: 'Riverside Market',
    eyebrow: 'Extensions',
    x: 88,
    y: 21,
    zoom: 1.11,
    accent: flowNodeColors.light.subflow,
    landmark: 'market',
  },
  statistics: {
    id: 'statistics',
    label: 'Current Gauge',
    eyebrow: 'Activity',
    x: 72,
    y: 74,
    zoom: 1.15,
    accent: flowNodeColors.dark.finish,
    landmark: 'gauge',
  },
  docs: {
    id: 'docs',
    label: 'River Archive',
    eyebrow: 'Help & docs',
    x: 48,
    y: 78,
    zoom: 1.13,
    accent: flowNodeColors.dark.signal,
    landmark: 'archive',
  },
  settings: {
    id: 'settings',
    label: 'Control House',
    eyebrow: 'Preferences',
    x: 24,
    y: 70,
    zoom: 1.15,
    accent: flowNodeColors.dark.start,
    landmark: 'control-house',
  },
} as const satisfies Readonly<Record<RiverSceneId, RiverScene>>;

interface RouteSceneRule {
  prefix: string;
  scene: RiverSceneId;
}

// Keep the more specific Automation routes before the umbrella prefix.
const ROUTE_SCENES: readonly RouteSceneRule[] = [
  { prefix: '/automation/waves', scene: 'waves' },
  { prefix: '/waves', scene: 'waves' },
  { prefix: '/automation/triggers', scene: 'automations' },
  { prefix: '/executions', scene: 'automations' },
  { prefix: '/automation', scene: 'automations' },
  { prefix: '/models', scene: 'models' },
  { prefix: '/mcp', scene: 'mcp' },
  { prefix: '/flows', scene: 'flows' },
  { prefix: '/chat', scene: 'chat' },
  { prefix: '/packages', scene: 'packages' },
  { prefix: '/statistics', scene: 'statistics' },
  { prefix: '/docs', scene: 'docs' },
  { prefix: '/settings', scene: 'settings' },
];

function normalizePathname(pathname: string | null | undefined): string {
  const pathOnly = pathname?.trim().split(/[?#]/, 1)[0] || '/';
  const withLeadingSlash = pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, '/');

  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

function matchesRoute(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function resolveRiverScene(pathname: string | null | undefined): RiverScene {
  const normalizedPathname = normalizePathname(pathname);
  const match = ROUTE_SCENES.find(({ prefix }) => matchesRoute(normalizedPathname, prefix));

  return match ? RIVER_SCENES[match.scene] : RIVER_SCENES.home;
}
import { flowNodeColors } from '@/frontend/utils/flowPaletteTokens';
