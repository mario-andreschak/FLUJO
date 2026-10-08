"use client";

import { Box } from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { useEffect, useRef, useState } from 'react';

import { useI18n } from '@/frontend/contexts/I18nContext';
import type { Persona, PersonaTaskSummary, PersonaWorkItem } from '@/shared/types/enduringAgent';

export default function PersonaStatusUpdates({ persona, tasks, workItems, lifecycleLabel }: {
  persona: Pick<Persona, 'id' | 'name' | 'lifecycleState'>;
  tasks: readonly PersonaTaskSummary[];
  workItems: readonly PersonaWorkItem[];
  lifecycleLabel: string;
}) {
  const { t, locale, formatList } = useI18n();
  const previous = useRef<{
    personaId: string;
    locale: string;
    lifecycle: Persona['lifecycleState'];
    states: Map<string, string>;
  } | null>(null);
  const [announcement, setAnnouncement] = useState<{ sequence: number; message: string } | null>(null);

  useEffect(() => {
    const goals = workItems.filter(item => item.goal);
    const goalIds = new Set(goals.map(item => item.id));
    const records = [
      ...goals.map(item => ({ id: item.id, name: item.title, state: `goal:${item.goal!.state}`, label: t(`personas.goal.${item.goal!.state}`) })),
      ...tasks.filter(task => !goalIds.has(task.id)).map(task => ({
        id: task.id, name: task.title, state: `task:${task.state}`, label: t(`personas.taskState.${task.state}`),
      })),
    ];
    const before = previous.current;
    previous.current = { personaId: persona.id, locale, lifecycle: persona.lifecycleState,
      states: new Map(records.map(record => [record.id, record.state])) };
    if (!before || before.personaId !== persona.id || before.locale !== locale) {
      setAnnouncement(null);
      return;
    }

    const changes = records.filter(record => before.states.has(record.id) && before.states.get(record.id) !== record.state);
    const messages = changes.slice(0, 3).map(record => t('personas.status.namedState', { name: record.name, status: record.label }));
    if (changes.length > 3) messages.push(t('personas.status.moreUpdates', { count: changes.length - 3 }));
    if (!messages.length && before.lifecycle !== persona.lifecycleState) {
      messages.push(t('personas.status.namedState', { name: persona.name, status: lifecycleLabel }));
    }
    if (messages.length) {
      const message = formatList(messages);
      setAnnouncement(current => ({ sequence: (current?.sequence ?? 0) + 1, message }));
    }
  }, [persona.id, persona.name, persona.lifecycleState, tasks, workItems, lifecycleLabel, t, locale, formatList]);

  return <Box role="status" aria-live="polite" aria-atomic="true" sx={visuallyHidden}>
    {announcement && <span key={announcement.sequence}>{announcement.message}</span>}
  </Box>;
}
