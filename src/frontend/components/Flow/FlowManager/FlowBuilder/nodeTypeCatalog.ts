import type { NodeType } from '@/frontend/types/flow/flow';
import type { Translator } from '@/frontend/i18n/core';

export interface AddableNodeType {
  type: NodeType;
  label: string;
  shortLabel: string;
  description: string;
}

/** Shared labels for both the palette rail and the toolbar type picker. */
export const getNodeTypes = (t: Translator): AddableNodeType[] => [
  // Start is automatically added to new flows and cannot be duplicated.
  {
    type: 'process',
    label: t('flows.palette.process'),
    shortLabel: t('flows.palette.processShort'),
    description: t('flows.palette.processHelp'),
  },
  {
    type: 'finish',
    label: t('flows.palette.finish'),
    shortLabel: t('flows.palette.finishShort'),
    description: t('flows.palette.finishHelp'),
  },
  {
    type: 'mcp',
    label: t('flows.palette.mcp'),
    shortLabel: t('flows.palette.mcpShort'),
    description: t('flows.palette.mcpHelp'),
  },
  {
    type: 'subflow',
    label: t('flows.palette.subflow'),
    shortLabel: t('flows.palette.subflowShort'),
    description: t('flows.palette.subflowHelp'),
  },
  {
    type: 'resource',
    label: t('flows.palette.resource'),
    shortLabel: t('flows.palette.resourceShort'),
    description: t('flows.palette.resourceHelp'),
  },
  {
    type: 'signal',
    label: t('flows.palette.signal'),
    shortLabel: t('flows.palette.signalShort'),
    description: t('flows.palette.signalHelp'),
  },
  {
    type: 'trigger',
    label: t('flows.palette.trigger'),
    shortLabel: t('flows.palette.triggerShort'),
    description: t('flows.palette.triggerHelp'),
  },
];
