import type { NodeType } from '@/frontend/types/flow/flow';

/**
 * Shared semantic colors for FlowBuilder nodes and adjacent visualizations.
 * Keeping these dependency-free lets canvas renderers reuse the product
 * palette without importing React or MUI components.
 */
export const flowNodeColors = {
  light: {
    start: '#7E889E',
    process: '#6355E8',
    finish: '#15885A',
    mcp: '#129DB8',
    subflow: '#C67A13',
    resource: '#18AFA3',
    signal: '#9A78FF',
    trigger: '#EF5D8E',
    static: '#8A6BD1',
  },
  dark: {
    start: '#B7C0D2',
    process: '#8B7CFF',
    finish: '#57D59B',
    mcp: '#31D2ED',
    subflow: '#F6BC66',
    resource: '#63D8CE',
    signal: '#C4B2FF',
    trigger: '#FF9ABD',
    static: '#BFA8F0',
  },
} as const satisfies Record<'light' | 'dark', Record<NodeType, string>>;

export const flowNodeLightColors = {
  resource: '#63D8CE',
  signal: '#C4B2FF',
  trigger: '#FF9ABD',
  static: '#BFA8F0',
} as const;
