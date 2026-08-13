"use client";

import type { PersonaActivity } from '@/shared/types/enduringAgent';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';

import { PersonasApiError } from './index';

const SUMMARY_PATH = '/v1/personas/summary';

export type PersonaHumanStatus =
  | 'working'
  | 'waiting-for-you'
  | 'up-next'
  | 'needs-attention';

export interface PersonaSummary {
  id: string;
  name: string;
  role: { id: string; name: string; version: number };
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
    call: boolean;
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
  signal?: AbortSignal;
}

async function parseSummary(response: Response): Promise<PersonaSummaryPage> {
  const body = await response.json().catch(() => null) as {
    error?: unknown;
  } | PersonaSummaryPage | null;
  if (!response.ok) {
    throw new PersonasApiError(
      response.status,
      body && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Persona request failed (HTTP ${response.status}).`,
    );
  }
  return body as PersonaSummaryPage;
}

export function listPersonaSummaries({
  cursor,
  pageSize,
  signal,
}: ListPersonaSummariesOptions = {}): Promise<PersonaSummaryPage> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (pageSize !== undefined) params.set('pageSize', String(pageSize));
  const query = params.toString();
  return fetch(withWorkspaceUrl(
    query ? `${SUMMARY_PATH}?${query}` : SUMMARY_PATH,
  ), { signal }).then(parseSummary);
}
