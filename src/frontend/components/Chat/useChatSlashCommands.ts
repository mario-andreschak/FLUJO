"use client";

import { useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { chatService } from '@/frontend/services/chat';
import { personasService } from '@/frontend/services/personas';
import {
  createChatSlashCommands,
  type ChatSlashActions,
  type ChatSlashContext,
  type ChatSlashServices,
} from './chatSlashCommands';
import type { SlashCommandHost } from './slashCommands';

const services: ChatSlashServices = {
  createGoal: (personaId, input) => personasService.createWorkItem(personaId, input),
  getGoal: (personaId, workItemId) => personasService.getWorkItem(personaId, workItemId),
  listGoals: (personaId) => personasService.listWorkItems(personaId),
  requestCompaction: (conversationId) => chatService.requestCompaction(conversationId),
  newId: () => uuidv4(),
};

/** The chat page's slash commands for the message box (#1225). */
export function useChatSlashCommands(context: ChatSlashContext, actions: ChatSlashActions): SlashCommandHost {
  const { t, tp, formatNumber } = useI18n();
  return useMemo(
    () => createChatSlashCommands(context, actions, services, { t, tp, formatNumber }),
    [context, actions, t, tp, formatNumber],
  );
}
