import type {
  Persona,
  PersonaActivity,
  RoleVersion,
} from '@/shared/types/enduringAgent';

import {
  listPersonas,
  listPersonaSummaryRecords,
} from './store';

export const DEFAULT_PERSONA_SUMMARY_PAGE_SIZE = 24;
export const MAX_PERSONA_SUMMARY_PAGE_SIZE = 100;

export type PersonaHumanStatus =
  | 'working'
  | 'waiting-for-you'
  | 'paused'
  | 'up-next'
  | 'needs-attention';

export interface PersonaSummary {
  id: string;
  name: string;
  role: Pick<RoleVersion, 'id' | 'name' | 'version'>;
  presentation?: { avatarUrl?: string };
  mission?: string;
  status: PersonaHumanStatus;
  currentWork: null | {
    activityId: string;
    kind: PersonaActivity['kind'];
    status: PersonaActivity['status'];
    summary?: string;
  };
  queuedCount: number;
  setupCounts: {
    behaviors: number;
    apps: number;
    memories: number;
  };
  capabilities: {
    talk: boolean;
    open: boolean;
    assign: boolean;
  };
  updatedAt: number;
}

export interface PersonaSummaryPage {
  items: PersonaSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ListPersonaSummariesOptions {
  cursor?: string | null;
  pageSize?: number;
}

export class InvalidPersonaSummaryCursorError extends Error {
  constructor() {
    super('Invalid Persona summary cursor.');
    this.name = 'InvalidPersonaSummaryCursorError';
  }
}

function encodeCursor(personaId: string): string {
  return Buffer.from(JSON.stringify({ after: personaId }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { after?: unknown };
    if (typeof value.after !== 'string' || value.after.length === 0) {
      throw new InvalidPersonaSummaryCursorError();
    }
    return value.after;
  } catch (error) {
    if (error instanceof InvalidPersonaSummaryCursorError) throw error;
    throw new InvalidPersonaSummaryCursorError();
  }
}

function boundedPageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PERSONA_SUMMARY_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('pageSize must be a positive integer.');
  }
  return Math.min(value, MAX_PERSONA_SUMMARY_PAGE_SIZE);
}

function latestActivity(
  activities: PersonaActivity[],
): PersonaActivity | undefined {
  const rank: Record<PersonaActivity['status'], number> = {
    running: 0,
    waiting: 1,
    error: 2,
    queued: 3,
    completed: 4,
    cancelled: 5,
  };
  return activities
    .filter((activity) => (
      activity.status === 'running'
      || activity.status === 'waiting'
      || activity.status === 'error'
      || activity.status === 'queued'
    ))
    .sort((left, right) => (
      rank[left.status] - rank[right.status]
      || right.updatedAt - left.updatedAt
      || left.id.localeCompare(right.id)
    ))[0];
}

function humanStatus(
  persona: Persona,
  activity: PersonaActivity | undefined,
  hasQueuedWork: boolean,
): PersonaHumanStatus {
  if (persona.lifecycleState === 'disabled' || persona.lifecycleState === 'error') {
    return 'needs-attention';
  }
  if (persona.lifecycleState === 'sleeping') return 'paused';
  if (activity?.status === 'running' || persona.lifecycleState === 'busy') {
    return 'working';
  }
  if (activity?.status === 'waiting' || persona.lifecycleState === 'waiting') {
    return 'waiting-for-you';
  }
  if (activity?.status === 'error') return 'needs-attention';
  if (hasQueuedWork) return 'up-next';
  return 'up-next';
}

export async function listPersonaSummaries(
  options: ListPersonaSummariesOptions = {},
): Promise<PersonaSummaryPage> {
  const pageSize = boundedPageSize(options.pageSize);
  const after = options.cursor ? decodeCursor(options.cursor) : null;
  const personas = await listPersonas();
  const start = after === null
    ? 0
    : personas.findIndex((persona) => persona.id > after);
  const pageStart = start < 0 ? personas.length : start;
  const page = personas.slice(pageStart, pageStart + pageSize);
  const hasMore = pageStart + page.length < personas.length;
  const records = await listPersonaSummaryRecords(page.map(({ id }) => id));
  const rolesById = new Map(records.roleVersions.map((role) => [role.id, role]));

  const items = page.map((persona): PersonaSummary => {
    const role = rolesById.get(persona.roleVersionId);
    if (!role) {
      throw new Error(
        `Persona ${JSON.stringify(persona.id)} references missing RoleVersion `
        + `${JSON.stringify(persona.roleVersionId)}.`,
      );
    }
    const activities = records.activities.filter((record) => record.personaId === persona.id);
    const current = latestActivity(activities);
    const mailboxItems = records.mailboxItems.filter((record) => record.personaId === persona.id);
    const queuedCount = mailboxItems.filter((record) => record.status === 'queued').length;
    const openWorkCount = records.workItems.filter((record) => (
      record.personaId === persona.id
      && record.status !== 'completed'
      && record.status !== 'cancelled'
    )).length;
    const currentMailbox = current
      ? mailboxItems.find((record) => record.claimedActivityId === current.id)
      : undefined;

    return {
      id: persona.id,
      name: persona.name,
      role: { id: role.id, name: role.name, version: role.version },
      ...(persona.presentation?.avatarUrl
        ? { presentation: { avatarUrl: persona.presentation.avatarUrl } }
        : {}),
      ...(persona.mission ? { mission: persona.mission } : {}),
      status: humanStatus(persona, current, queuedCount > 0 || openWorkCount > 0),
      currentWork: current
        ? {
          activityId: current.id,
          kind: current.kind,
          status: current.status,
          ...(currentMailbox?.summary ? { summary: currentMailbox.summary } : {}),
        }
        : null,
      queuedCount,
      setupCounts: {
        behaviors: records.behaviorBindings.filter(
          (record) => record.personaId === persona.id,
        ).length,
        apps: records.appGrants.filter((record) => record.personaId === persona.id).length,
        memories: records.memoryItems.filter((record) => (
          record.personaId === persona.id && record.status !== 'forgotten'
        )).length,
      },
      capabilities: {
        talk: persona.lifecycleState !== 'disabled' && persona.lifecycleState !== 'error',
        open: true,
        assign: persona.lifecycleState !== 'disabled',
      },
      updatedAt: Math.max(
        persona.updatedAt,
        current?.updatedAt ?? 0,
        ...mailboxItems.map((record) => record.updatedAt),
      ),
    };
  });

  return {
    items,
    hasMore,
    nextCursor: hasMore && page.length > 0
      ? encodeCursor(page[page.length - 1].id)
      : null,
  };
}
